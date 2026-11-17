// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.t.sol";
import {RefractEngine} from "../src/RefractEngine.sol";
import {MockFeed} from "./Mocks.sol";

contract RefractEngineTest is Base {
    // ───────── Lens ─────────

    function test_lens_depositWithdraw() public {
        assertEq(eng.poolNav(), 5_000_000e18);
        uint256 sh = eng.sharesOf(lp);
        vm.prank(lp);
        uint256 paid = eng.lpWithdraw(sh / 2);
        assertEq(paid, 2_500_000 * U);
        assertEq(eng.poolNav(), 2_500_000e18);
    }

    function test_lens_withdrawPartialWhenReserved() public {
        uint256 pid = _crystal(alice, 2_000_000 * U);
        _beam(alice, pid, 0, a1, 2_000_000e18, 10e18);
        _trade(a1, pid, 0, M_BTC, 100e18); // ~$10M notional long; reserve 20% = ~$2M
        uint256 sh = eng.sharesOf(lp);
        int256 nav = eng.poolNav();
        int256 reserve = eng.lensReserve();
        assertGt(reserve, 1_900_000e18);
        vm.prank(lp);
        uint256 paid = eng.lpWithdraw(sh);
        assertApproxEqAbs(int256(paid * 1e12), nav - reserve, 1e13); // partial fill up to the free amount
        assertGt(eng.sharesOf(lp), 0); // the rest stays with the LP, nobody blocked it
    }

    // ───────── mirror: beam books = real book ─────────

    function test_beamTradeMirrorsRealBook() public {
        uint256 pid = _crystal(alice, 100_000 * U);
        _beam(alice, pid, 0, a1, 50_000e18, 5e18);
        _trade(a1, pid, 0, M_BTC, 1e18);
        assertEq(eng.realPosition(pid, M_BTC).size, 1e18);
        assertEq(eng.beamPosition(pid, 0, M_BTC).size, 1e18);
        // Lens price: 100k * (1 + 0.5/10000)
        assertEq(eng.realPosition(pid, M_BTC).last, 100_005e18);
        _px(BTC, 110_000e18, true);
        assertEq(eng.beamEquity(pid, 0), 50_000e18 - 50.0025e18 + 9_995e18);
        assertEq(_pnlReal(pid), _pnlBeams(pid));
    }

    // ───────── netted margin across agents ─────────

    function test_nettedMargin_oppositeAgentsNeedNoMargin() public {
        uint256 pid = _crystal(alice, 15_000 * U);
        _beam(alice, pid, 0, a1, 100_000e18, 5e18);
        _beam(alice, pid, 1, a2, 100_000e18, 5e18);
        _trade(a1, pid, 0, M_BTC, 2e18); // IM 10k on 15k
        _trade(a2, pid, 1, M_BTC, -2e18); // nets to zero
        (, int256 im,) = eng.crystalRisk(pid);
        assertEq(im, 0);
        assertApproxEqAbs(eng.grossMargin(pid), 20_000e18, 1e18); // standalone margin would exceed the deposit
        // a2 can add more short only because the net stays covered
        _trade(a2, pid, 1, M_BTC, -2e18); // net -2 => IM ~10k
        (, im,) = eng.crystalRisk(pid);
        assertApproxEqAbs(im, 10_000e18, 5e18);
        assertEq(_pnlReal(pid), _pnlBeams(pid));
    }

    function test_beamReductionThatRaisesNetExposureIsMarginChecked() public {
        uint256 pid = _crystal(alice, 6_000 * U);
        _beam(alice, pid, 0, a1, 50_000e18, 5e18);
        _beam(alice, pid, 1, a2, 50_000e18, 5e18);
        _trade(a1, pid, 0, M_BTC, 1e18);
        _trade(a2, pid, 1, M_BTC, -1e18);
        _trade(a1, pid, 0, M_BTC, 1e18); // net +1 => IM 5k on ~6k
        // a2 closing its short would leave net +2 => IM 10k > equity
        vm.prank(a2);
        vm.expectRevert(RefractEngine.InsufficientMargin.selector);
        eng.trade(pid, 1, M_BTC, 1e18, 0);
    }

    // ───────── beam rules ─────────

    function test_beamRules() public {
        uint256 pid = _crystal(alice, 100_000 * U);
        _beam(alice, pid, 0, a1, 10_000e18, 5e18); // cap 50k notional
        vm.prank(a1);
        vm.expectRevert(RefractEngine.OverBeamCap.selector);
        eng.trade(pid, 0, M_BTC, 0.6e18, 0);
        vm.prank(b1);
        vm.expectRevert(RefractEngine.NotAgent.selector);
        eng.trade(pid, 0, M_BTC, 0.1e18, 0);
        vm.prank(alice);
        eng.setBeam(
            pid,
            0,
            RefractEngine.BeamParams({
                agent: a1,
                until: uint64(t + 1 days),
                marketMask: 1, // BTC only
                softBps: 500,
                hardBps: 750,
                perfFeeBps: 2000,
                budget: 10_000e18,
                levCap: 5e18
            })
        );
        vm.prank(a1);
        vm.expectRevert(RefractEngine.MarketNotAllowed.selector);
        eng.trade(pid, 0, M_NVDA, 10e18, 0);
        _adv(2 days);
        _px(BTC, 100_000e18, true);
        vm.prank(a1);
        vm.expectRevert(RefractEngine.BeamExpired.selector);
        eng.trade(pid, 0, M_BTC, 0.1e18, 0);
    }

    // ───────── pod-shop drawdown: halve, then cut ─────────

    function test_drawdown_softHalvesThenHardCuts() public {
        uint256 pid = _crystal(alice, 100_000 * U);
        _beam(alice, pid, 0, a1, 10_000e18, 10e18); // cap 100k
        _trade(a1, pid, 0, M_BTC, 0.9e18);
        // ~-5.9% on the beam: halved
        _px(BTC, 99_400e18, true);
        vm.prank(keeper);
        eng.enforce(pid, 0);
        assertEq(uint8(eng.beam(pid, 0).state), uint8(RefractEngine.BeamState.Halved));
        vm.prank(a1);
        vm.expectRevert(RefractEngine.OverBeamCap.selector);
        eng.trade(pid, 0, M_BTC, 0.1e18, 0); // cap is now 50k
        // reducing is still allowed
        _trade(a1, pid, 0, M_BTC, -0.1e18);
        // -8% : the agent is locked out until someone cuts
        _px(BTC, 98_900e18, true);
        vm.prank(a1);
        vm.expectRevert(RefractEngine.MustCutFirst.selector);
        eng.trade(pid, 0, M_BTC, -0.1e18, 0);
        vm.prank(keeper);
        eng.enforce(pid, 0);
        assertEq(uint8(eng.beam(pid, 0).state), uint8(RefractEngine.BeamState.Cut));
        assertEq(eng.beamPosition(pid, 0, M_BTC).size, 0);
        assertEq(eng.realPosition(pid, M_BTC).size, 0);
        vm.prank(a1);
        vm.expectRevert(RefractEngine.BeamClosed.selector);
        eng.trade(pid, 0, M_BTC, 0.1e18, 0);
        vm.prank(alice);
        eng.rearm(pid, 0);
        _trade(a1, pid, 0, M_BTC, 0.1e18);
        assertEq(_pnlReal(pid), _pnlBeams(pid));
    }

    function test_budgetTopUpIsNotProfit() public {
        uint256 pid = _crystal(alice, 100_000 * U);
        _beam(alice, pid, 0, a1, 10_000e18, 5e18);
        int256 hwm0 = eng.beam(pid, 0).hwm;
        _beam(alice, pid, 0, a1, 20_000e18, 5e18);
        assertEq(eng.beam(pid, 0).hwm, hwm0 + 10_000e18);
        assertEq(eng.beam(pid, 0).feeHwm, hwm0 + 10_000e18);
    }

    // ───────── crossing windows ─────────

    function _two() internal returns (uint256 pa, uint256 pb) {
        pa = _crystal(alice, 200_000 * U);
        _beam(alice, pa, 0, a1, 100_000e18, 10e18);
        pb = _crystal(bob, 200_000 * U);
        _beam(bob, pb, 0, b1, 100_000e18, 10e18);
    }

    function test_cross_matchesAtMarkResidualToLens() public {
        (uint256 pa, uint256 pb) = _two();
        uint64 w = uint64(t) / eng.WINDOW();
        vm.prank(a1);
        eng.queueCross(pa, 0, M_BTC, 3e18, 50);
        vm.prank(b1);
        eng.queueCross(pb, 0, M_BTC, -2e18, 50);
        vm.expectRevert(RefractEngine.WindowOpen.selector);
        eng.settleWindow(M_BTC, w);
        _adv(eng.WINDOW());
        _px(BTC, 101_000e18, true);
        int256 proto0 = eng.protocolFees();
        eng.settleWindow(M_BTC, w);
        assertEq(eng.realPosition(pa, M_BTC).size, 3e18);
        assertEq(eng.realPosition(pb, M_BTC).size, -2e18);
        assertEq(eng.market(M_BTC).skew, 1e18); // only the imbalance reached the Lens
        assertEq(eng.realPosition(pb, M_BTC).last, 101_000e18); // crossed at the mark
        // bob paid the 1 bp crossing fee on 2 BTC
        (, , , int256 cb,,,,,) = eng.crystals(pb);
        assertEq(cb, 200_000e18 - 20.2e18);
        assertGt(eng.protocolFees(), proto0);
        assertEq(_pnlReal(pa), _pnlBeams(pa));
        assertEq(_pnlReal(pb), _pnlBeams(pb));
        (, , , , , , , , int256 pendA) = eng.crystals(pa);
        assertEq(pendA, 0);
    }

    function test_cross_orderCapPerBeam() public {
        (uint256 pa,) = _two();
        vm.startPrank(a1);
        eng.queueCross(pa, 0, M_BTC, 0.1e18, 50);
        eng.queueCross(pa, 0, M_BTC, 0.1e18, 50);
        vm.expectRevert(RefractEngine.WindowFull.selector);
        eng.queueCross(pa, 0, M_BTC, 0.1e18, 50);
        vm.stopPrank();
    }

    function test_cross_residualDroppedWhenSlipTooTight() public {
        (uint256 pa, uint256 pb) = _two();
        uint64 w = uint64(t) / eng.WINDOW();
        vm.prank(a1);
        eng.queueCross(pa, 0, M_BTC, 3e18, 0); // accepts no Lens premium
        vm.prank(b1);
        eng.queueCross(pb, 0, M_BTC, -2e18, 0);
        _adv(eng.WINDOW());
        _px(BTC, 100_000e18, true);
        eng.settleWindow(M_BTC, w);
        assertEq(eng.realPosition(pa, M_BTC).size, 2e18);
        assertEq(eng.realPosition(pb, M_BTC).size, -2e18);
        assertEq(eng.market(M_BTC).skew, 0);
    }

    function test_cross_proRataAcrossHeavySide() public {
        (uint256 pa, uint256 pb) = _two();
        _beam(alice, pa, 1, a2, 100_000e18, 10e18);
        uint64 w = uint64(t) / eng.WINDOW();
        vm.prank(a1);
        eng.queueCross(pa, 0, M_BTC, 3e18, 0);
        vm.prank(a2);
        eng.queueCross(pa, 1, M_BTC, 1e18, 0);
        vm.prank(b1);
        eng.queueCross(pb, 0, M_BTC, -2e18, 0);
        _adv(eng.WINDOW());
        _px(BTC, 100_000e18, true);
        eng.settleWindow(M_BTC, w);
        assertEq(eng.beamPosition(pa, 0, M_BTC).size, 1.5e18);
        assertEq(eng.beamPosition(pa, 1, M_BTC).size, 0.5e18);
        assertEq(eng.realPosition(pa, M_BTC).size, 2e18);
        assertEq(eng.market(M_BTC).skew, 0);
    }

    function test_cross_priceTimingAndVoid() public {
        (uint256 pa,) = _two();
        uint64 w = uint64(t) / eng.WINDOW();
        vm.prank(a1);
        eng.queueCross(pa, 0, M_BTC, 1e18, 50);
        _adv(eng.WINDOW());
        feed.set(BTC, 100_000e18, uint64(t - 1), true); // no report at the exact close
        vm.expectRevert(MockFeed.NoPriceAt.selector);
        eng.settleWindow(M_BTC, w);
        _adv(eng.SETTLE_GRACE() + 1);
        eng.voidWindow(M_BTC, w);
        (, , , , , , , , int256 pend) = eng.crystals(pa);
        assertEq(pend, 0);
        assertEq(eng.beam(pa, 0).pending, 0);
        assertEq(eng.realPosition(pa, M_BTC).size, 0);
    }

    // ───────── funding ─────────

    function test_funding_longsPayLensWhenSkewLong() public {
        uint256 pid = _crystal(alice, 1_000_000 * U);
        _beam(alice, pid, 0, a1, 1_000_000e18, 10e18);
        _trade(a1, pid, 0, M_BTC, 50e18);
        int256 nav0 = eng.poolNav();
        int256 eq0 = eng.beamEquity(pid, 0);
        _adv(1 days);
        _px(BTC, 100_000e18, true); // same mark: only funding moves
        int256 paid = eq0 - eng.beamEquity(pid, 0);
        // rate = 0.01 * 50/10000 per day on $5M => $250
        assertApproxEqRel(paid, 250e18, 0.001e18);
        assertApproxEqAbs(eng.poolNav() - nav0, paid, 1e12);
        assertEq(_pnlReal(pid), _pnlBeams(pid));
    }

    // ───────── liquidation, flatten, exits ─────────

    function test_liquidation_closesEverything() public {
        uint256 pid = _crystal(alice, 6_000 * U);
        _beam(alice, pid, 0, a1, 100_000e18, 20e18);
        _trade(a1, pid, 0, M_BTC, 1e18); // 100k notional on 6k
        _px(BTC, 96_000e18, true);
        vm.prank(keeper);
        eng.liquidate(pid);
        assertEq(eng.realPosition(pid, M_BTC).size, 0);
        assertEq(eng.beamPosition(pid, 0, M_BTC).size, 0);
        assertEq(uint8(eng.beam(pid, 0).state), uint8(RefractEngine.BeamState.Cut));
        assertGt(usdg.balanceOf(keeper), 0);
        vm.expectRevert(RefractEngine.NotLiquidatable.selector);
        eng.liquidate(pid);
        assertApproxEqAbs(_pnlReal(pid), _pnlBeams(pid), 1e6);
    }

    function test_liquidation_needsFreshPriceFor247Markets() public {
        uint256 pid = _crystal(alice, 6_000 * U);
        _beam(alice, pid, 0, a1, 100_000e18, 20e18);
        _trade(a1, pid, 0, M_BTC, 1e18);
        feed.set(BTC, 96_000e18, uint64(t), true);
        _adv(120);
        vm.expectRevert(RefractEngine.StalePrice.selector);
        eng.liquidate(pid);
    }

    function test_flattenAndWithdrawWorkWhilePaused() public {
        uint256 pid = _crystal(alice, 100_000 * U);
        _beam(alice, pid, 0, a1, 50_000e18, 5e18);
        _beam(alice, pid, 1, a2, 50_000e18, 5e18);
        _trade(a1, pid, 0, M_BTC, 1e18);
        _trade(a2, pid, 1, M_NVDA, -500e18);
        vm.prank(guardian);
        eng.pauseOpens(true);
        vm.prank(a1);
        vm.expectRevert(RefractEngine.OpensPaused.selector);
        eng.trade(pid, 0, M_BTC, 0.1e18, 0);
        _trade(a1, pid, 0, M_BTC, -0.5e18); // reducing works while paused
        vm.prank(a1);
        vm.expectRevert(RefractEngine.NotOwner.selector);
        eng.withdraw(pid, 1 * U); // agents can never withdraw
        vm.startPrank(alice);
        eng.flatten(pid);
        (, , , int256 c,,,,,) = eng.crystals(pid);
        eng.withdraw(pid, uint256(c) / 1e12);
        vm.stopPrank();
        assertGt(usdg.balanceOf(alice), 99_000 * U);
        assertEq(_pnlReal(pid), _pnlBeams(pid));
        // LPs can still leave too
        uint256 sh = eng.sharesOf(lp);
        vm.prank(lp);
        assertGt(eng.lpWithdraw(sh), 0);
    }

    function test_equityOffHours_reduceOnly() public {
        uint256 pid = _crystal(alice, 100_000 * U);
        _beam(alice, pid, 0, a1, 50_000e18, 5e18);
        _trade(a1, pid, 0, M_NVDA, 100e18);
        _px(NVDA, 201e18, false); // market closed, price held
        vm.prank(a1);
        vm.expectRevert(RefractEngine.MarketClosed.selector);
        eng.trade(pid, 0, M_NVDA, 10e18, 0);
        _trade(a1, pid, 0, M_NVDA, -50e18);
        assertEq(eng.beamPosition(pid, 0, M_NVDA).size, 50e18);
    }

    // ───────── performance fee ─────────

    function test_crystallize_paysOnNewHighsOnly() public {
        uint256 pid = _crystal(alice, 100_000 * U);
        _beam(alice, pid, 0, a1, 50_000e18, 5e18);
        _trade(a1, pid, 0, M_BTC, 1e18);
        _px(BTC, 110_000e18, true);
        vm.expectRevert(RefractEngine.TooSoon.selector);
        eng.crystallize(pid, 0);
        _adv(7 days);
        _px(BTC, 110_000e18, true);
        int256 gain = eng.beamEquity(pid, 0) - 50_000e18;
        eng.crystallize(pid, 0);
        assertApproxEqAbs(int256(usdg.balanceOf(a1)) * 1e12, gain * 2000 / 10_000, 1e12);
        _adv(7 days);
        _px(BTC, 105_000e18, true);
        uint256 before = usdg.balanceOf(a1);
        eng.crystallize(pid, 0); // below the fee high-water mark: nothing
        assertEq(usdg.balanceOf(a1), before);
        assertEq(_pnlReal(pid), _pnlBeams(pid));
    }

    // ───────── cash conservation ─────────

    function test_cashConservation() public {
        (uint256 pa, uint256 pb) = _two();
        _trade(a1, pa, 0, M_BTC, 2e18);
        _trade(b1, pb, 0, M_NVDA, -100e18);
        _px(BTC, 103_000e18, true);
        _trade(a1, pa, 0, M_BTC, -1e18);
        assertEq(int256(usdg.balanceOf(address(eng))) * 1e12, _cash());
    }
}
