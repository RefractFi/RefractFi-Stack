// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {RefractEngine} from "../src/RefractEngine.sol";
import {IPriceFeed} from "../src/interfaces/IPriceFeed.sol";
import {MockFeed} from "./Mocks.sol";

/// @notice Engine against the real USDG on a Robinhood Chain mainnet fork (approve flow: USDG has no permit).
///         Skipped unless FORK_RPC is set: FORK_RPC=https://rpc.mainnet.chain.robinhood.com forge test --mc Fork
contract ForkTest is Test {
    IERC20 constant USDG = IERC20(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);
    bytes32 constant BTC = bytes32(uint256(0x0003) << 240 | 1);
    uint256 constant U = 1e6;

    RefractEngine eng;
    MockFeed feed;
    address lp = makeAddr("lp");
    address alice = makeAddr("alice");
    address trend = makeAddr("trend");
    address revert_ = makeAddr("revert");

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);
        feed = new MockFeed();
        feed.set(BTC, 100_000e18, uint64(block.timestamp), true);
        eng = new RefractEngine(USDG, IPriceFeed(address(feed)), address(this), address(this));
        eng.listMarket(
            RefractEngine.MarketParams({
                feedId: BTC, maxLev: 20e18, mmr: 0.025e18, takerFeeBps: 5, crossFeeBps: 1, skewScale: 10_000e18,
                maxFundingPerDay: 0.01e18, maxSkew: 500e18, maxAge: 60
            })
        );
        _fund(lp, 1_000_000 * U);
        vm.prank(lp);
        eng.lpDeposit(1_000_000 * U);
    }

    function _fund(address who, uint256 amt) internal {
        deal(address(USDG), who, amt);
        vm.prank(who);
        USDG.approve(address(eng), amt);
    }

    function _beam(uint256 pid, uint256 bid, address agent) internal {
        vm.prank(alice);
        eng.setBeam(pid, bid, RefractEngine.BeamParams({
            agent: agent, until: uint64(block.timestamp + 30 days), marketMask: 1, softBps: 500, hardBps: 750,
            perfFeeBps: 2000, budget: 10_000e18, levCap: 20e18 // 2 BTC @ $100k = $200k = $10k × 20x
        }));
    }

    /// USDG the engine holds must equal Σ collateral + Lens cash + protocol fees, exactly (WAD = USDG × 1e12).
    function _assertConserved() internal view {
        (,,, int256 c,,,,,) = eng.crystals(1);
        assertEq(int256(USDG.balanceOf(address(eng))) * 1e12, c + eng.poolCash() + eng.protocolFees());
    }

    function test_fork_realUsdg_netting_flatten_withdraw() public {
        _fund(alice, 15_000 * U);
        vm.startPrank(alice);
        uint256 pid = eng.openCrystal();
        eng.deposit(pid, 15_000 * U);
        vm.stopPrank();
        _beam(pid, 0, trend);
        _beam(pid, 1, revert_);
        _assertConserved();

        // The overview's example: long 2 BTC + short 2 BTC on $15k. Separate accounts would need $20k at 20x.
        vm.prank(trend);
        eng.trade(pid, 0, 0, 2e18, 0);
        vm.prank(revert_);
        eng.trade(pid, 1, 0, -2e18, 0);
        (, int256 im,) = eng.crystalRisk(pid);
        assertEq(im, 0, "net zero book needs no margin");
        assertGt(eng.grossMargin(pid), 15_000e18, "standalone margin would exceed the deposit");
        _assertConserved();

        // Agents can never withdraw.
        vm.prank(trend);
        vm.expectRevert(RefractEngine.NotOwner.selector);
        eng.withdraw(pid, 1);

        vm.startPrank(alice);
        eng.flatten(pid);
        (int256 eq,,) = eng.crystalRisk(pid);
        uint256 out = uint256(eq / 1e12);
        eng.withdraw(pid, out);
        vm.stopPrank();
        assertEq(USDG.balanceOf(alice), out);
        // Two Lens fills of $200k at 5 bps = $200 in taker fees; flattening a net-zero book costs no fee.
        assertApproxEqAbs(out, 14_800 * U, 1 * U, "only the 5 bps opening fees were paid");
        _assertConserved();
    }
}
