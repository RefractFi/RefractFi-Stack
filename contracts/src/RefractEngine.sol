// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPriceFeed} from "./interfaces/IPriceFeed.sol";

/// @title RefractEngine
/// @notice Agent-native perps on Robinhood Chain.
///   - A Crystal is one owner's margin account (USDG).
///   - Capital is refracted into Beams: AI agents, each trading a virtual sub-book with its own budget, leverage cap,
///     market list, expiry and drawdown rules (soft cut halves the budget, hard cut closes the beam).
///   - Real margin is charged on the Crystal's NET position across all beams. A beam's PnL is computed exactly as if it
///     traded alone at the prices it actually got, so agent records stay honest.
///   - Orders can trade immediately against the Lens (the LP pool) or join a crossing window: opposite orders from
///     any beams cross at the oracle mark; only the imbalance trades with the Lens.
/// @dev All internal amounts are 18-decimal (WAD). USDG has 6 decimals.
contract RefractEngine is ReentrancyGuard {
    using SafeERC20 for IERC20;

    int256 internal constant WAD = 1e18;
    uint256 internal constant SCALE = 1e12;
    uint256 public constant MAX_MARKETS = 32;
    uint256 public constant MAX_BEAMS = 16;
    uint256 public constant MAX_ORDERS = 32;
    uint256 public constant MAX_ORDERS_PER_BEAM = 2;
    uint64 public constant WINDOW = 5; // seconds
    uint64 public constant SETTLE_GRACE = 120; // after this, an unsettled window can be voided
    uint64 public constant CRYSTAL_INTERVAL = 7 days;
    uint16 public constant LIQ_FEE_BPS = 50;
    uint16 public constant MAX_PERF_FEE_BPS = 3000;

    // ───────────────────────── types ─────────────────────────

    struct MarketParams {
        bytes32 feedId;
        int256 maxLev; // WAD (20e18 = 20x)
        int256 mmr; // WAD maintenance margin ratio
        uint16 takerFeeBps;
        uint16 crossFeeBps;
        int256 skewScale; // WAD base units
        int256 maxFundingPerDay; // WAD fraction of price per day at |skew| >= skewScale
        int256 maxSkew; // WAD base units: cap on the Lens' net exposure
        uint32 maxAge; // seconds
    }

    struct Market {
        MarketParams p;
        bool listed;
        int256 skew; // Σ real crystal sizes (traders' net); the Lens holds -skew
        int256 sumSL; // Σ size*last/WAD
        int256 sumSF; // Σ size*f0/WAD
        int256 fundingIndex; // WAD USD per base unit; longs owe size*Δindex
        uint64 lastAccrual;
    }

    struct Pos {
        int256 size;
        int256 last;
        int256 f0;
    }

    enum BeamState {
        None,
        Active,
        Halved,
        Cut
    }

    struct BeamParams {
        address agent;
        uint64 until;
        uint32 marketMask;
        uint16 softBps;
        uint16 hardBps;
        uint16 perfFeeBps;
        int256 budget; // WAD USD
        int256 levCap; // WAD
    }

    struct Beam {
        BeamParams p;
        BeamState state;
        uint32 openMask;
        int256 realized; // virtual: settled PnL - fees - funding
        int256 hwm; // risk high-water mark of beam equity
        int256 feeHwm; // performance-fee high-water mark
        uint64 lastCrystal;
        int256 pending; // notional queued in open crossing windows
    }

    struct Crystal {
        address owner;
        uint8 beamCount;
        uint32 openMask;
        int256 collateral;
        int256 netDeposits;
        int256 perfPaid;
        int256 liqPaid;
        int256 badDebt;
        int256 pending; // notional queued in open crossing windows
    }

    struct Order {
        uint64 crystalId;
        uint8 beamId;
        uint16 maxSlipBps;
        int256 size;
        int256 pendingNotional; // margin reserved at queue time, released exactly at settle or void
    }

    // ───────────────────────── storage ─────────────────────────

    IERC20 public immutable usdg;
    IPriceFeed public immutable feed;
    address public admin;
    address public guardian;
    bool public opensPaused;
    uint16 public protocolShareBps = 2000; // of taker fees; crossing fees go fully to the protocol
    int256 public reserveRatio = 0.2e18; // Lens NAV kept against |skew| notional

    uint256 public marketCount;
    mapping(uint256 => Market) internal markets;

    uint256 public crystalCount;
    mapping(uint256 => Crystal) public crystals;
    mapping(uint256 => mapping(uint256 => Beam)) internal beams;
    mapping(uint256 => mapping(uint256 => Pos)) internal realPos;
    mapping(uint256 => mapping(uint256 => mapping(uint256 => Pos))) internal beamPos;

    mapping(uint256 => mapping(uint64 => Order[])) internal windowOrders;
    mapping(uint256 => mapping(uint64 => bool)) public windowDone;
    mapping(bytes32 => uint256) internal beamOrders; // keccak(market, window, crystal, beam) => count

    int256 public poolCash;
    uint256 public totalShares;
    mapping(address => uint256) public sharesOf;
    int256 public protocolFees;

    /// @notice R0 launch caps (overview §6: Lens $2M, $50k per Crystal until the audit). USDG units; 0 = no cap.
    ///         Deposits only: withdrawals and every exit path ignore them.
    uint256 public lensCap;
    uint256 public crystalCap;

    // ───────────────────────── events / errors ─────────────────────────

    event MarketListed(uint256 indexed market, bytes32 feedId);
    event CrystalOpened(uint256 indexed crystal, address indexed owner);
    event Deposited(uint256 indexed crystal, uint256 amount);
    event Withdrawn(uint256 indexed crystal, uint256 amount);
    event BeamSet(uint256 indexed crystal, uint256 indexed beam, address agent);
    event BeamState_(uint256 indexed crystal, uint256 indexed beam, BeamState state, int256 equity, int256 hwm);
    event Filled(
        uint256 indexed crystal, uint256 indexed beam, uint256 indexed market, int256 size, int256 price, int256 fee, bool crossed
    );
    event Queued(uint256 indexed market, uint64 indexed window, uint256 crystal, uint256 beam, int256 size);
    event WindowSettled(uint256 indexed market, uint64 indexed window, int256 matched, int256 residual, bool residualFilled, int256 mark);
    event Flattened(uint256 indexed crystal, bool liquidation, int256 fee);
    event Crystallized(uint256 indexed crystal, uint256 indexed beam, address agent, uint256 paid);
    event LpDeposit(address indexed lp, uint256 amount, uint256 shares);
    event LpWithdraw(address indexed lp, uint256 shares, uint256 paid);
    event CapsSet(uint256 lensCap, uint256 crystalCap);
    event MarketSet(uint256 indexed market);
    event AdminSet(address admin);
    event GuardianSet(address guardian);
    event ProtocolShareSet(uint16 bps);
    event OpensPausedSet(bool on);
    event ProtocolFeesTaken(address to, uint256 amount);

    error NotAdmin();
    error NotGuardian();
    error NotOwner();
    error NotAgent();
    error BadParams();
    error BeamExpired();
    error BeamClosed();
    error MarketNotAllowed();
    error OpensPaused();
    error MarketClosed();
    error OverBeamCap();
    error OverSkewCap();
    error InsufficientMargin();
    error Slippage();
    error StalePrice();
    error WindowOpen();
    error WindowFull();
    error AlreadySettled();
    error NotLiquidatable();
    error MustCutFirst();
    error TooSoon();
    error NothingToEnforce();
    error OverCap();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyOwner(uint256 pid) {
        if (msg.sender != crystals[pid].owner) revert NotOwner();
        _;
    }

    constructor(IERC20 usdg_, IPriceFeed feed_, address admin_, address guardian_) {
        usdg = usdg_;
        feed = feed_;
        admin = admin_;
        guardian = guardian_;
    }

    // ───────────────────────── admin ─────────────────────────

    function listMarket(MarketParams calldata p) external onlyAdmin returns (uint256 m) {
        if (marketCount >= MAX_MARKETS) revert BadParams();
        _checkMarket(p);
        m = marketCount++;
        Market storage mk = markets[m];
        mk.p = p;
        mk.listed = true;
        mk.lastAccrual = uint64(block.timestamp);
        emit MarketListed(m, p.feedId);
    }

    function setMarket(uint256 m, MarketParams calldata p) external onlyAdmin {
        _checkMarket(p);
        Market storage mk = markets[m];
        if (!mk.listed) revert BadParams();
        (int256 P,) = _markUnchecked(m);
        _accrue(m, P);
        mk.p = p;
        emit MarketSet(m);
    }

    function _checkMarket(MarketParams calldata p) internal pure {
        if (
            p.maxLev < WAD || p.maxLev > 100e18 || p.mmr <= 0 || p.mmr * p.maxLev >= WAD * WAD
                || p.skewScale <= 0 || p.maxSkew <= 0 || p.takerFeeBps > 100 || p.crossFeeBps > p.takerFeeBps
                || p.maxFundingPerDay < 0 || p.maxAge == 0
        ) revert BadParams();
    }

    function setGuardian(address g) external onlyAdmin {
        guardian = g;
        emit GuardianSet(g);
    }

    function setAdmin(address a) external onlyAdmin {
        admin = a;
        emit AdminSet(a);
    }

    function setCaps(uint256 lens, uint256 crystal) external onlyAdmin {
        lensCap = lens;
        crystalCap = crystal;
        emit CapsSet(lens, crystal);
    }

    function setProtocolShare(uint16 bps) external onlyAdmin {
        if (bps > 5000) revert BadParams();
        protocolShareBps = bps;
        emit ProtocolShareSet(bps);
    }

    /// @notice Pauses new risk only. Reducing, closing, flattening, withdrawing and LP exits never pause.
    function pauseOpens(bool on) external {
        if (msg.sender != guardian && msg.sender != admin) revert NotGuardian();
        opensPaused = on;
        emit OpensPausedSet(on);
    }

    function takeProtocolFees(address to) external onlyAdmin {
        uint256 amt = uint256(protocolFees) / SCALE;
        protocolFees -= int256(amt * SCALE);
        usdg.safeTransfer(to, amt);
        emit ProtocolFeesTaken(to, amt);
    }

    // ───────────────────────── Lens (LPs) ─────────────────────────

    function lpDeposit(uint256 amount) external nonReentrant returns (uint256 shares) {
        int256 nav = poolNav();
        if (lensCap != 0 && (nav > 0 ? uint256(nav) / SCALE : 0) + amount > lensCap) revert OverCap();
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        int256 v = int256(amount * SCALE);
        if (totalShares == 0) {
            shares = uint256(v);
        } else {
            if (nav <= 0) revert BadParams();
            shares = uint256(v) * totalShares / uint256(nav);
        }
        poolCash += v;
        totalShares += shares;
        sharesOf[msg.sender] += shares;
        emit LpDeposit(msg.sender, amount, shares);
    }

    /// @notice Pays out as much as the reserve allows right now; unpaid shares stay with the LP. Nobody can block it.
    function lpWithdraw(uint256 shares) external nonReentrant returns (uint256 paid) {
        if (shares > sharesOf[msg.sender] || shares == 0) revert BadParams();
        int256 nav = poolNav();
        if (nav <= 0) return 0;
        int256 value = int256(shares * uint256(nav) / totalShares);
        int256 free = nav - lensReserve();
        if (free <= 0) return 0;
        if (value > free) {
            shares = shares * uint256(free) / uint256(value);
            value = free;
        }
        paid = uint256(value) / SCALE;
        sharesOf[msg.sender] -= shares;
        totalShares -= shares;
        poolCash -= int256(paid * SCALE);
        usdg.safeTransfer(msg.sender, paid);
        emit LpWithdraw(msg.sender, shares, paid);
    }

    function poolNav() public view returns (int256 nav) {
        nav = poolCash;
        for (uint256 m; m < marketCount; ++m) {
            Market storage mk = markets[m];
            if (mk.skew == 0 && mk.sumSL == 0 && mk.sumSF == 0) continue;
            (int256 P,) = _markUnchecked(m);
            int256 I = _indexNow(m, P);
            // traders' aggregate unrealized PnL is the Lens' liability
            nav -= (mk.skew * P / WAD - mk.sumSL) - (mk.skew * I / WAD - mk.sumSF);
        }
    }

    function lensReserve() public view returns (int256 r) {
        for (uint256 m; m < marketCount; ++m) {
            Market storage mk = markets[m];
            if (mk.skew == 0) continue;
            (int256 P,) = _markUnchecked(m);
            r += _abs(mk.skew) * P / WAD * reserveRatio / WAD;
        }
    }

    // ───────────────────────── Crystals and beams ─────────────────────────

    function openCrystal() external returns (uint256 pid) {
        pid = ++crystalCount;
        crystals[pid].owner = msg.sender;
        emit CrystalOpened(pid, msg.sender);
    }

    function deposit(uint256 pid, uint256 amount) external nonReentrant {
        Crystal storage pr = crystals[pid];
        if (pr.owner == address(0)) revert BadParams();
        if (crystalCap != 0 && (pr.collateral > 0 ? uint256(pr.collateral) / SCALE : 0) + amount > crystalCap) {
            revert OverCap();
        }
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        pr.collateral += int256(amount * SCALE);
        pr.netDeposits += int256(amount * SCALE);
        emit Deposited(pid, amount);
    }

    /// @notice Owner withdraws while the net position stays above initial margin. Flatten first to take everything.
    function withdraw(uint256 pid, uint256 amount) external nonReentrant onlyOwner(pid) {
        Crystal storage pr = crystals[pid];
        int256 v = int256(amount * SCALE);
        pr.collateral -= v;
        pr.netDeposits -= v;
        if (pr.openMask != 0 || pr.pending != 0) {
            (int256 eq, int256 im,) = _crystalRisk(pid);
            if (eq < im + pr.pending * WAD / _minLev()) revert InsufficientMargin();
        } else if (pr.collateral < 0) {
            revert InsufficientMargin();
        }
        usdg.safeTransfer(msg.sender, amount);
        emit Withdrawn(pid, amount);
    }

    function setBeam(uint256 pid, uint256 bid, BeamParams calldata p) external onlyOwner(pid) {
        if (bid >= MAX_BEAMS || p.agent == address(0) || p.budget <= 0 || p.levCap <= 0) revert BadParams();
        if (p.hardBps == 0 || p.softBps >= p.hardBps || p.hardBps >= 10_000 || p.perfFeeBps > MAX_PERF_FEE_BPS) {
            revert BadParams();
        }
        Crystal storage pr = crystals[pid];
        Beam storage b = beams[pid][bid];
        if (b.state == BeamState.None) {
            if (bid != pr.beamCount) revert BadParams(); // beams are added in order
            pr.beamCount++;
            b.state = BeamState.Active;
            b.lastCrystal = uint64(block.timestamp);
            b.p = p;
            int256 eq = _beamEquity(pid, bid);
            b.hwm = eq;
            b.feeHwm = eq;
        } else {
            // budget changes move the high-water marks by the same amount, so a top-up never reads as profit
            int256 dBudget = p.budget - b.p.budget;
            b.p = p;
            b.hwm += dBudget;
            b.feeHwm += dBudget;
        }
        emit BeamSet(pid, bid, p.agent);
    }

    /// @notice Owner re-arms a halved or cut beam: the high-water mark resets to current equity.
    function rearm(uint256 pid, uint256 bid) external onlyOwner(pid) {
        Beam storage b = beams[pid][bid];
        if (b.state == BeamState.None) revert BadParams();
        b.state = BeamState.Active;
        b.hwm = _beamEquity(pid, bid);
        emit BeamState_(pid, bid, BeamState.Active, b.hwm, b.hwm);
    }

    function cutBeam(uint256 pid, uint256 bid) external nonReentrant onlyOwner(pid) {
        _cut(pid, bid);
    }

    // ───────────────────────── agent trading ─────────────────────────

    /// @notice Immediate fill against the Lens at the skew-adjusted price.
    function trade(uint256 pid, uint256 bid, uint256 m, int256 size, int256 limitPrice) external nonReentrant {
        Beam storage b = _agentBeam(pid, bid);
        (int256 P, bool open) = _mark(m);
        _accrue(m, P);
        _riskGate(pid, bid);
        bool increases = _checkBeamTrade(pid, bid, m, size, P, open, 0);
        Market storage mk = markets[m];
        int256 newSkew = mk.skew + size;
        if (_abs(newSkew) > mk.p.maxSkew && _abs(newSkew) > _abs(mk.skew)) revert OverSkewCap();
        int256 F = _fillPrice(mk, P, size);
        if (limitPrice != 0 && ((size > 0 && F > limitPrice) || (size < 0 && F < limitPrice))) revert Slippage();
        bool realGrows = _realGrows(pid, m, size);
        int256 fee = _fill(pid, bid, m, size, F, mk.p.takerFeeBps, true);
        emit Filled(pid, bid, m, size, F, fee, false);
        if (increases || realGrows) _requireMargin(pid);
        _bumpHwm(pid, bid, b);
    }

    /// @notice Joins the current crossing window. Settles at the first oracle mark observed after the window closes.
    function queueCross(uint256 pid, uint256 bid, uint256 m, int256 size, uint16 maxSlipBps) external nonReentrant {
        _agentBeam(pid, bid);
        if (size == 0) revert BadParams();
        (int256 P, bool open) = _mark(m);
        _accrue(m, P);
        _riskGate(pid, bid);
        uint64 w = uint64(block.timestamp) / WINDOW;
        Order[] storage os = windowOrders[m][w];
        if (os.length >= MAX_ORDERS) revert WindowFull();
        bytes32 key = keccak256(abi.encode(m, w, pid, bid));
        if (++beamOrders[key] > MAX_ORDERS_PER_BEAM) revert WindowFull();
        Beam storage b = beams[pid][bid];
        bool increases = _checkBeamTrade(pid, bid, m, size, P, open, b.pending);
        int256 n;
        if (increases || _realGrows(pid, m, size)) {
            n = _abs(size) * P / WAD;
            if (increases) b.pending += n;
            crystals[pid].pending += n;
            _requireMargin(pid);
        }
        os.push(Order(uint64(pid), uint8(bid), maxSlipBps, size, increases ? n : -n));
        emit Queued(m, w, pid, bid, size);
    }

    // ───────────────────────── crossing windows ─────────────────────────

    struct SettleVars {
        int256 P;
        int256 F;
        int256 buys;
        int256 sells;
        int256 matched;
        int256 larger;
        int256 residual;
        bool residualOk;
        bool buySideLarger;
        uint256 lastLarge;
        int256 crossedSoFar;
    }

    /// @notice Anyone settles a closed window at the verified mark observed exactly at the close.
    ///         Opposite orders cross at that mark; the imbalance trades with the Lens
    ///         only if every order on the heavy side accepts the Lens price, otherwise those orders fill only their
    ///         crossed share.
    function settleWindow(uint256 m, uint64 w) external nonReentrant {
        if (windowDone[m][w]) revert AlreadySettled();
        uint64 end = (w + 1) * WINDOW;
        if (block.timestamp < end) revert WindowOpen();
        Market storage mk = markets[m];
        (int256 P, bool open) = feed.priceAt(mk.p.feedId, end);
        windowDone[m][w] = true;
        _accrue(m, P);

        Order[] storage os = windowOrders[m][w];
        uint256 n = os.length;
        bool[] memory ok = new bool[](n);
        SettleVars memory v;
        v.P = P;
        for (uint256 i; i < n; ++i) {
            Order storage o = os[i];
            _releasePending(o);
            ok[i] = _orderStillValid(o, m, P, open);
            if (!ok[i]) continue;
            if (o.size > 0) v.buys += o.size;
            else v.sells -= o.size;
        }
        v.buySideLarger = v.buys > v.sells;
        v.matched = v.buys < v.sells ? v.buys : v.sells;
        v.larger = v.buySideLarger ? v.buys : v.sells;
        v.residual = v.buys - v.sells;
        if (v.residual != 0) {
            v.F = _fillPrice(mk, P, v.residual);
            int256 newSkew = mk.skew + v.residual;
            v.residualOk = !(_abs(newSkew) > mk.p.maxSkew && _abs(newSkew) > _abs(mk.skew));
            for (uint256 i; i < n && v.residualOk; ++i) {
                if (!ok[i] || (os[i].size > 0) != v.buySideLarger) continue;
                if (_abs(v.F - P) * 10_000 > int256(uint256(os[i].maxSlipBps)) * P) v.residualOk = false;
                v.lastLarge = i;
            }
            if (!v.residualOk) {
                for (uint256 i; i < n; ++i) {
                    if (ok[i] && (os[i].size > 0) == v.buySideLarger) v.lastLarge = i;
                }
            }
        }

        for (uint256 i; i < n; ++i) {
            if (!ok[i]) continue;
            Order storage o = os[i];
            int256 crossQty;
            int256 resQty;
            bool heavy = v.residual != 0 && (o.size > 0) == v.buySideLarger;
            if (!heavy) {
                crossQty = o.size;
            } else {
                if (i == v.lastLarge) {
                    // dust: the last heavy order takes the exact remainder of the matched quantity
                    crossQty = (o.size > 0 ? v.matched : -v.matched) - v.crossedSoFar;
                } else {
                    crossQty = o.size * v.matched / v.larger;
                    v.crossedSoFar += crossQty;
                }
                if (v.residualOk) resQty = o.size - crossQty;
            }
            if (crossQty != 0) {
                int256 fee = _fill(o.crystalId, o.beamId, m, crossQty, P, mk.p.crossFeeBps, false);
                emit Filled(o.crystalId, o.beamId, m, crossQty, P, fee, true);
            }
            if (resQty != 0) {
                int256 fee = _fill(o.crystalId, o.beamId, m, resQty, v.F, mk.p.takerFeeBps, true);
                emit Filled(o.crystalId, o.beamId, m, resQty, v.F, fee, false);
            }
            _bumpHwm(o.crystalId, o.beamId, beams[o.crystalId][o.beamId]);
        }
        emit WindowSettled(m, w, v.matched, v.residual, v.residualOk, P);
    }

    /// @notice Voids a window nobody settled in time; queued orders simply expire.
    function voidWindow(uint256 m, uint64 w) external {
        if (windowDone[m][w]) revert AlreadySettled();
        if (block.timestamp <= (w + 1) * WINDOW + SETTLE_GRACE) revert WindowOpen();
        windowDone[m][w] = true;
        Order[] storage os = windowOrders[m][w];
        for (uint256 i; i < os.length; ++i) {
            _releasePending(os[i]);
        }
        emit WindowSettled(m, w, 0, 0, false, 0);
    }

    /// @dev pendingNotional > 0: reserved on the beam and the crystal; < 0: reserved on the crystal only.
    function _releasePending(Order storage o) internal {
        int256 n = o.pendingNotional;
        if (n == 0) return;
        if (n > 0) beams[o.crystalId][o.beamId].pending -= n;
        else n = -n;
        crystals[o.crystalId].pending -= n;
    }

    function _realGrows(uint256 pid, uint256 m, int256 size) internal view returns (bool) {
        int256 S = realPos[pid][m].size;
        return _abs(S + size) > _abs(S);
    }

    function _orderStillValid(Order storage o, uint256 m, int256 P, bool open) internal view returns (bool) {
        Beam storage b = beams[o.crystalId][o.beamId];
        if (b.state != BeamState.Active && b.state != BeamState.Halved) return false;
        if (block.timestamp > b.p.until) return false;
        Pos storage bp = beamPos[o.crystalId][o.beamId][m];
        int256 s1 = bp.size + o.size;
        bool increases = _abs(s1) > _abs(bp.size) || (bp.size != 0 && (s1 > 0) != (bp.size > 0) && s1 != 0);
        if (!increases) return true;
        if (opensPaused || !open) return false;
        int256 cap = b.p.budget * b.p.levCap / WAD;
        if (b.state == BeamState.Halved) cap /= 2;
        int256 gross = _beamGross(o.crystalId, o.beamId) - _abs(bp.size) * P / WAD + _abs(s1) * P / WAD;
        return gross <= cap;
    }

    // ───────────────────────── risk: cuts, flatten, liquidation ─────────────────────────

    /// @notice Anyone may enforce a beam's drawdown rules.
    function enforce(uint256 pid, uint256 bid) external nonReentrant {
        Beam storage b = beams[pid][bid];
        if (b.state != BeamState.Active && b.state != BeamState.Halved) revert BeamClosed();
        int256 eq = _beamEquity(pid, bid);
        if (eq <= b.hwm - b.hwm * int256(uint256(b.p.hardBps)) / 10_000) {
            _cut(pid, bid);
        } else if (b.state == BeamState.Active && eq <= b.hwm - b.hwm * int256(uint256(b.p.softBps)) / 10_000) {
            b.state = BeamState.Halved;
            emit BeamState_(pid, bid, BeamState.Halved, eq, b.hwm);
        } else {
            revert NothingToEnforce();
        }
    }

    /// @notice Owner kill switch: closes every position and stops every beam. Works while opens are paused.
    function flatten(uint256 pid) external nonReentrant onlyOwner(pid) {
        _flatten(pid, false);
    }

    function liquidate(uint256 pid) external nonReentrant {
        (int256 eq,, int256 mm) = _crystalRisk(pid);
        if (crystals[pid].openMask == 0 || eq >= mm) revert NotLiquidatable();
        int256 notional = _flatten(pid, true);
        Crystal storage pr = crystals[pid];
        int256 fee = notional * int256(uint256(LIQ_FEE_BPS)) / 10_000;
        if (fee > pr.collateral) fee = pr.collateral > 0 ? pr.collateral : int256(0);
        uint256 paid = uint256(fee) / SCALE;
        pr.collateral -= int256(paid * SCALE);
        pr.liqPaid += int256(paid * SCALE);
        if (pr.collateral < 0) {
            poolCash += pr.collateral; // the Lens absorbs bad debt
            pr.badDebt -= pr.collateral;
            pr.collateral = 0;
        }
        if (paid > 0) usdg.safeTransfer(msg.sender, paid);
        emit Flattened(pid, true, int256(paid * SCALE));
    }

    function _flatten(uint256 pid, bool liq) internal returns (int256 notional) {
        Crystal storage pr = crystals[pid];
        uint256 nb = pr.beamCount;
        // close every beam's virtual book at the same price as the real net close, per market
        for (uint256 m; m < marketCount; ++m) {
            Pos storage rp = realPos[pid][m];
            bool beamsHold;
            for (uint256 bid; bid < nb; ++bid) {
                if (beamPos[pid][bid][m].size != 0) {
                    beamsHold = true;
                    break;
                }
            }
            if (rp.size == 0 && !beamsHold) continue;
            int256 P = liq ? _markForLiq(m) : _price(m);
            _accrue(m, P);
            Market storage mk = markets[m];
            int256 S = rp.size;
            int256 F = S == 0 ? P : _fillPrice(mk, P, -S);
            int256 fee;
            if (S != 0) {
                fee = _abs(S) * F / WAD * int256(uint256(mk.p.takerFeeBps)) / 10_000;
                notional += _abs(S) * F / WAD;
                _settleReal(pid, m, F, -S);
                pr.collateral -= fee;
                _payTakerFee(fee);
            }
            // fee is charged to the beams on the same side as the net, pro rata to size
            int256 sameSide;
            for (uint256 bid; bid < nb; ++bid) {
                int256 s = beamPos[pid][bid][m].size;
                if (S != 0 && s != 0 && (s > 0) == (S > 0)) sameSide += _abs(s);
            }
            int256 feeLeft = fee;
            uint256 lastSame = type(uint256).max;
            for (uint256 bid; bid < nb; ++bid) {
                int256 s = beamPos[pid][bid][m].size;
                if (S != 0 && s != 0 && (s > 0) == (S > 0)) lastSame = bid;
            }
            for (uint256 bid; bid < nb; ++bid) {
                int256 s = beamPos[pid][bid][m].size;
                if (s == 0) continue;
                _settleBeam(pid, bid, m, F, -s);
                if (S != 0 && (s > 0) == (S > 0)) {
                    int256 part = bid == lastSame ? feeLeft : fee * _abs(s) / sameSide;
                    feeLeft -= part;
                    beams[pid][bid].realized -= part;
                }
            }
        }
        for (uint256 bid; bid < nb; ++bid) {
            Beam storage b = beams[pid][bid];
            if (b.state != BeamState.Cut) {
                b.state = BeamState.Cut;
                emit BeamState_(pid, bid, BeamState.Cut, _beamEquity(pid, bid), b.hwm);
            }
        }
        if (!liq) emit Flattened(pid, false, 0);
    }

    function _cut(uint256 pid, uint256 bid) internal {
        Beam storage b = beams[pid][bid];
        if (b.state == BeamState.None) revert BadParams();
        uint32 mask = b.openMask;
        for (uint256 m; mask != 0; ++m) {
            if (mask & 1 == 1) {
                (int256 P,) = _markUnchecked(m);
                _accrue(m, P);
                int256 s = beamPos[pid][bid][m].size;
                Market storage mk = markets[m];
                int256 F = _fillPrice(mk, P, -s);
                int256 fee = _fill(pid, bid, m, -s, F, mk.p.takerFeeBps, true);
                emit Filled(pid, bid, m, -s, F, fee, false);
            }
            mask >>= 1;
        }
        b.state = BeamState.Cut;
        emit BeamState_(pid, bid, BeamState.Cut, _beamEquity(pid, bid), b.hwm);
    }

    // ───────────────────────── performance fees ─────────────────────────

    /// @notice Pays the agent its fee on new beam equity highs, at most once per interval, from the owner's crystal.
    function crystallize(uint256 pid, uint256 bid) external nonReentrant {
        Beam storage b = beams[pid][bid];
        if (b.state == BeamState.None) revert BadParams();
        if (block.timestamp < b.lastCrystal + CRYSTAL_INTERVAL) revert TooSoon();
        b.lastCrystal = uint64(block.timestamp);
        int256 eq = _beamEquity(pid, bid);
        if (eq <= b.feeHwm) return;
        int256 fee = (eq - b.feeHwm) * int256(uint256(b.p.perfFeeBps)) / 10_000;
        b.feeHwm = eq;
        uint256 paid = uint256(fee) / SCALE;
        if (paid == 0) return;
        Crystal storage pr = crystals[pid];
        pr.collateral -= int256(paid * SCALE);
        pr.perfPaid += int256(paid * SCALE);
        if (pr.openMask != 0) {
            (int256 peq, int256 im,) = _crystalRisk(pid);
            if (peq < im) revert InsufficientMargin();
        } else if (pr.collateral < 0) {
            revert InsufficientMargin();
        }
        usdg.safeTransfer(b.p.agent, paid);
        emit Crystallized(pid, bid, b.p.agent, paid);
    }

    // ───────────────────────── views ─────────────────────────

    function market(uint256 m) external view returns (Market memory) {
        return markets[m];
    }

    function beam(uint256 pid, uint256 bid) external view returns (Beam memory) {
        return beams[pid][bid];
    }

    function realPosition(uint256 pid, uint256 m) external view returns (Pos memory) {
        return realPos[pid][m];
    }

    function beamPosition(uint256 pid, uint256 bid, uint256 m) external view returns (Pos memory) {
        return beamPos[pid][bid][m];
    }

    function windowOf(uint256 m, uint64 w) external view returns (Order[] memory) {
        return windowOrders[m][w];
    }

    /// @return equity real crystal equity at marks, im initial margin on the NET position, mm maintenance margin
    function crystalRisk(uint256 pid) external view returns (int256 equity, int256 im, int256 mm) {
        return _crystalRisk(pid);
    }

    function beamEquity(uint256 pid, uint256 bid) external view returns (int256) {
        return _beamEquity(pid, bid);
    }

    function beamGross(uint256 pid, uint256 bid) external view returns (int256) {
        return _beamGross(pid, bid);
    }

    /// @notice Margin the crystal would need if each beam were margined alone (gross); compare with crystalRisk().im.
    function grossMargin(uint256 pid) external view returns (int256 im) {
        Crystal storage pr = crystals[pid];
        for (uint256 bid; bid < pr.beamCount; ++bid) {
            uint32 mask = beams[pid][bid].openMask;
            for (uint256 m; mask != 0; ++m) {
                if (mask & 1 == 1) {
                    (int256 P,) = _markUnchecked(m);
                    im += _abs(beamPos[pid][bid][m].size) * P / markets[m].p.maxLev;
                }
                mask >>= 1;
            }
        }
    }

    function quote(uint256 m, int256 size) external view returns (int256 mark, int256 lensPrice) {
        (mark,) = _mark(m);
        lensPrice = _fillPrice(markets[m], mark, size);
    }

    // ───────────────────────── internals ─────────────────────────

    function _agentBeam(uint256 pid, uint256 bid) internal view returns (Beam storage b) {
        b = beams[pid][bid];
        if (msg.sender != b.p.agent) revert NotAgent();
        if (block.timestamp > b.p.until) revert BeamExpired();
        if (b.state != BeamState.Active && b.state != BeamState.Halved) revert BeamClosed();
    }

    /// @dev Drawdown rules run before every agent action. A hard breach must be enforced first (by anyone).
    function _riskGate(uint256 pid, uint256 bid) internal {
        Beam storage b = beams[pid][bid];
        int256 eq = _beamEquity(pid, bid);
        if (eq <= b.hwm - b.hwm * int256(uint256(b.p.hardBps)) / 10_000) revert MustCutFirst();
        if (b.state == BeamState.Active && eq <= b.hwm - b.hwm * int256(uint256(b.p.softBps)) / 10_000) {
            b.state = BeamState.Halved;
            emit BeamState_(pid, bid, BeamState.Halved, eq, b.hwm);
        }
    }

    function _checkBeamTrade(uint256 pid, uint256 bid, uint256 m, int256 size, int256 P, bool open, int256 extra)
        internal
        view
        returns (bool increases)
    {
        Beam storage b = beams[pid][bid];
        if (!markets[m].listed || (b.p.marketMask >> m) & 1 == 0) revert MarketNotAllowed();
        int256 s0 = beamPos[pid][bid][m].size;
        int256 s1 = s0 + size;
        increases = _abs(s1) > _abs(s0) || (s0 != 0 && s1 != 0 && (s1 > 0) != (s0 > 0));
        if (!increases) return false;
        if (opensPaused) revert OpensPaused();
        if (!open) revert MarketClosed();
        int256 cap = b.p.budget * b.p.levCap / WAD;
        if (b.state == BeamState.Halved) cap /= 2;
        int256 gross = _beamGross(pid, bid) - _abs(s0) * P / WAD + _abs(s1) * P / WAD + extra;
        if (gross > cap) revert OverBeamCap();
    }

    function _requireMargin(uint256 pid) internal view {
        (int256 eq, int256 im,) = _crystalRisk(pid);
        Crystal storage pr = crystals[pid];
        if (eq < im + pr.pending * WAD / _minLev()) revert InsufficientMargin();
    }

    function _minLev() internal view returns (int256 lev) {
        lev = 100e18;
        for (uint256 m; m < marketCount; ++m) {
            if (markets[m].p.maxLev < lev) lev = markets[m].p.maxLev;
        }
    }

    /// @dev One fill: the beam's virtual book and the crystal's real book move together at the same price and fee.
    function _fill(uint256 pid, uint256 bid, uint256 m, int256 size, int256 price, uint16 feeBps, bool lens)
        internal
        returns (int256 fee)
    {
        fee = _abs(size) * price / WAD * int256(uint256(feeBps)) / 10_000;
        _settleBeam(pid, bid, m, price, size);
        _settleReal(pid, m, price, size);
        crystals[pid].collateral -= fee;
        beams[pid][bid].realized -= fee;
        if (lens) _payTakerFee(fee);
        else protocolFees += fee;
    }

    function _payTakerFee(int256 fee) internal {
        int256 proto = fee * int256(uint256(protocolShareBps)) / 10_000;
        protocolFees += proto;
        poolCash += fee - proto;
    }

    function _settleReal(uint256 pid, uint256 m, int256 P, int256 delta) internal {
        Market storage mk = markets[m];
        Pos storage p = realPos[pid][m];
        int256 I = mk.fundingIndex;
        int256 pnl = (p.size * (P - p.last) - p.size * (I - p.f0)) / WAD;
        Crystal storage pr = crystals[pid];
        pr.collateral += pnl;
        poolCash -= pnl;
        mk.sumSL -= p.size * p.last / WAD;
        mk.sumSF -= p.size * p.f0 / WAD;
        p.size += delta;
        p.last = P;
        p.f0 = I;
        mk.sumSL += p.size * P / WAD;
        mk.sumSF += p.size * I / WAD;
        mk.skew += delta;
        if (p.size == 0) pr.openMask &= ~uint32(1 << m);
        else pr.openMask |= uint32(1 << m);
    }

    function _settleBeam(uint256 pid, uint256 bid, uint256 m, int256 P, int256 delta) internal {
        Pos storage p = beamPos[pid][bid][m];
        Beam storage b = beams[pid][bid];
        int256 I = markets[m].fundingIndex;
        b.realized += (p.size * (P - p.last) - p.size * (I - p.f0)) / WAD;
        p.size += delta;
        p.last = P;
        p.f0 = I;
        if (p.size == 0) b.openMask &= ~uint32(1 << m);
        else b.openMask |= uint32(1 << m);
    }

    function _bumpHwm(uint256 pid, uint256 bid, Beam storage b) internal {
        int256 eq = _beamEquity(pid, bid);
        if (eq > b.hwm) b.hwm = eq;
    }

    /// @dev Skew-adjusted Lens price: the premium is the average skew across the trade over skewScale.
    function _fillPrice(Market storage mk, int256 P, int256 size) internal view returns (int256) {
        int256 avgSkew = mk.skew + size / 2;
        int256 premium = avgSkew * WAD / mk.p.skewScale;
        if (premium > WAD / 10) premium = WAD / 10;
        if (premium < -WAD / 10) premium = -WAD / 10;
        return P * (WAD + premium) / WAD;
    }

    function _accrue(uint256 m, int256 P) internal {
        Market storage mk = markets[m];
        mk.fundingIndex = _indexNow(m, P);
        mk.lastAccrual = uint64(block.timestamp);
    }

    function _indexNow(uint256 m, int256 P) internal view returns (int256) {
        Market storage mk = markets[m];
        uint256 dt = block.timestamp - mk.lastAccrual;
        if (dt == 0 || mk.skew == 0) return mk.fundingIndex;
        int256 frac = mk.skew * WAD / mk.p.skewScale;
        if (frac > WAD) frac = WAD;
        if (frac < -WAD) frac = -WAD;
        int256 ratePerDay = frac * mk.p.maxFundingPerDay / WAD;
        return mk.fundingIndex + ratePerDay * P / WAD * int256(dt) / 1 days;
    }

    function _mark(uint256 m) internal view returns (int256 P, bool open) {
        Market storage mk = markets[m];
        if (!mk.listed) revert MarketNotAllowed();
        uint64 ts;
        (P, ts, open) = feed.latest(mk.p.feedId);
        if (P <= 0 || block.timestamp > ts + mk.p.maxAge) revert StalePrice();
    }

    /// @dev Risk-reducing paths (cuts, flatten, liquidation, views) use the last verified price even if it is old:
    ///      equities hold their last price off-hours and exits must never wait for a feed.
    function _markUnchecked(uint256 m) internal view returns (int256 P, bool open) {
        (P,, open) = feed.latest(markets[m].p.feedId);
    }

    function _price(uint256 m) internal view returns (int256 P) {
        (P,,) = feed.latest(markets[m].p.feedId);
    }

    /// @dev Liquidations need a fresh price for 24/7 markets; a closed equity market liquidates on its held price.
    function _markForLiq(uint256 m) internal view returns (int256 P) {
        uint64 ts;
        bool open;
        (P, ts, open) = feed.latest(markets[m].p.feedId);
        if (open && block.timestamp > ts + markets[m].p.maxAge) revert StalePrice();
    }

    function _beamEquity(uint256 pid, uint256 bid) internal view returns (int256 eq) {
        Beam storage b = beams[pid][bid];
        eq = b.p.budget + b.realized;
        uint32 mask = b.openMask;
        for (uint256 m; mask != 0; ++m) {
            if (mask & 1 == 1) {
                Pos storage p = beamPos[pid][bid][m];
                (int256 P,) = _markUnchecked(m);
                int256 I = _indexNow(m, P);
                eq += (p.size * (P - p.last) - p.size * (I - p.f0)) / WAD;
            }
            mask >>= 1;
        }
    }

    function _beamGross(uint256 pid, uint256 bid) internal view returns (int256 g) {
        uint32 mask = beams[pid][bid].openMask;
        for (uint256 m; mask != 0; ++m) {
            if (mask & 1 == 1) {
                (int256 P,) = _markUnchecked(m);
                g += _abs(beamPos[pid][bid][m].size) * P / WAD;
            }
            mask >>= 1;
        }
    }

    function _crystalRisk(uint256 pid) internal view returns (int256 eq, int256 im, int256 mm) {
        Crystal storage pr = crystals[pid];
        eq = pr.collateral;
        uint32 mask = pr.openMask;
        for (uint256 m; mask != 0; ++m) {
            if (mask & 1 == 1) {
                Pos storage p = realPos[pid][m];
                Market storage mk = markets[m];
                (int256 P,) = _markUnchecked(m);
                int256 I = _indexNow(m, P);
                eq += (p.size * (P - p.last) - p.size * (I - p.f0)) / WAD;
                int256 notional = _abs(p.size) * P / WAD;
                im += notional * WAD / mk.p.maxLev;
                mm += notional * mk.p.mmr / WAD;
            }
            mask >>= 1;
        }
    }

    function _abs(int256 x) internal pure returns (int256) {
        return x < 0 ? -x : x;
    }
}
