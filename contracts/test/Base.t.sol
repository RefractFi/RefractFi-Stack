// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {RefractEngine} from "../src/RefractEngine.sol";
import {IPriceFeed} from "../src/interfaces/IPriceFeed.sol";
import {MockUSDG, MockFeed} from "./Mocks.sol";

abstract contract Base is Test {
    RefractEngine eng;
    MockUSDG usdg;
    MockFeed feed;

    address admin = makeAddr("admin");
    address guardian = makeAddr("guardian");
    address lp = makeAddr("lp");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address a1 = makeAddr("agentA1");
    address a2 = makeAddr("agentA2");
    address b1 = makeAddr("agentB1");
    address keeper = makeAddr("keeper");

    bytes32 constant BTC = bytes32(uint256(0x0003) << 240 | 1);
    bytes32 constant NVDA = bytes32(uint256(0x0008) << 240 | 2);
    uint256 constant M_BTC = 0;
    uint256 constant M_NVDA = 1;

    int256 constant WAD = 1e18;
    uint256 constant U = 1e6; // one USDG

    // own clock: via-IR may cache block.timestamp inside a test function
    uint256 t = 1_800_000_000;

    function setUp() public virtual {
        vm.warp(t);
        usdg = new MockUSDG();
        feed = new MockFeed();
        eng = new RefractEngine(IERC20(address(usdg)), IPriceFeed(address(feed)), admin, guardian);
        _px(BTC, 100_000e18, true);
        _px(NVDA, 200e18, true);
        vm.startPrank(admin);
        eng.listMarket(
            RefractEngine.MarketParams({
                feedId: BTC,
                maxLev: 20e18,
                mmr: 0.025e18,
                takerFeeBps: 5,
                crossFeeBps: 1,
                skewScale: 10_000e18,
                maxFundingPerDay: 0.01e18,
                maxSkew: 500e18,
                maxAge: 60
            })
        );
        eng.listMarket(
            RefractEngine.MarketParams({
                feedId: NVDA,
                maxLev: 10e18,
                mmr: 0.05e18,
                takerFeeBps: 5,
                crossFeeBps: 1,
                skewScale: 5_000_000e18,
                maxFundingPerDay: 0.01e18,
                maxSkew: 200_000e18,
                maxAge: 60
            })
        );
        vm.stopPrank();
        _fund(lp, 5_000_000 * U);
        vm.prank(lp);
        eng.lpDeposit(5_000_000 * U);
    }

    function _px(bytes32 id, int256 price, bool open) internal {
        feed.set(id, price, uint64(t), open);
    }

    function _adv(uint256 s) internal {
        t += s;
        vm.warp(t);
    }

    function _fund(address who, uint256 amt) internal {
        usdg.mint(who, amt);
        vm.prank(who);
        usdg.approve(address(eng), type(uint256).max);
    }

    function _crystal(address owner, uint256 amt) internal returns (uint256 pid) {
        _fund(owner, amt);
        vm.startPrank(owner);
        pid = eng.openCrystal();
        eng.deposit(pid, amt);
        vm.stopPrank();
    }

    function _beam(address owner, uint256 pid, uint256 bid, address agent, int256 budget, int256 lev) internal {
        vm.prank(owner);
        eng.setBeam(
            pid,
            bid,
            RefractEngine.BeamParams({
                agent: agent,
                until: uint64(t + 365 days),
                marketMask: 3,
                softBps: 500,
                hardBps: 750,
                perfFeeBps: 2000,
                budget: budget,
                levCap: lev
            })
        );
    }

    function _trade(address agent, uint256 pid, uint256 bid, uint256 m, int256 size) internal {
        vm.prank(agent);
        eng.trade(pid, bid, m, size, 0);
    }

    function _pnlReal(uint256 pid) internal view returns (int256) {
        (int256 eq,,) = eng.crystalRisk(pid);
        (, , , , int256 netDeposits, int256 perfPaid, int256 liqPaid, int256 badDebt,) = eng.crystals(pid);
        return eq - netDeposits + perfPaid + liqPaid - badDebt;
    }

    function _pnlBeams(uint256 pid) internal view returns (int256 s) {
        (, uint8 n,,,,,,,) = eng.crystals(pid);
        for (uint256 i; i < n; ++i) {
            s += eng.beamEquity(pid, i) - eng.beam(pid, i).p.budget;
        }
    }

    function _cash() internal view returns (int256 s) {
        for (uint256 pid = 1; pid <= eng.crystalCount(); ++pid) {
            (, , , int256 c,,,,,) = eng.crystals(pid);
            s += c;
        }
        s += eng.poolCash() + eng.protocolFees();
    }
}
