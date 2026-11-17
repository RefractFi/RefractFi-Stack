// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.t.sol";

/// @notice Random sequences of trades, crossings, price moves, funding time, cuts and fee crystallizations.
///         After every step: (1) USDG held == Σ collateral + Lens cash + protocol fees, exactly;
///         (2) for each crystal, the real book's PnL == the sum of its beams' virtual PnL (to rounding dust).
contract ConservationTest is Base {
    uint256 pa;
    uint256 pb;
    address[3] agents;
    uint256[3] pids;
    uint256[3] bids;

    function setUp() public override {
        super.setUp();
        pa = _crystal(alice, 2_000_000 * U);
        _beam(alice, pa, 0, a1, 600_000e18, 10e18);
        _beam(alice, pa, 1, a2, 600_000e18, 10e18);
        pb = _crystal(bob, 2_000_000 * U);
        _beam(bob, pb, 0, b1, 600_000e18, 10e18);
        agents = [a1, a2, b1];
        pids = [pa, pa, pb];
        bids = [uint256(0), 1, 0];
    }

    function _check() internal view {
        assertEq(int256(usdg.balanceOf(address(eng))) * 1e12, _cash(), "cash");
        assertApproxEqAbs(_pnlReal(pa), _pnlBeams(pa), 1e8, "mirror a");
        assertApproxEqAbs(_pnlReal(pb), _pnlBeams(pb), 1e8, "mirror b");
    }

    function testFuzz_conservation(uint256 seed) public {
        int256 btc = 100_000e18;
        int256 nvda = 200e18;
        uint256 fills;
        uint256 crosses;
        for (uint256 step; step < 30; ++step) {
            uint256 r = uint256(keccak256(abi.encode(seed, step)));
            uint256 op = r % 7;
            uint256 k = (r >> 8) % 3;
            uint256 m = (r >> 16) % 2;
            int256 size = int256(((r >> 24) % 3000) + 1) * (m == 0 ? int256(1e15) : int256(1e17));
            if ((r >> 40) % 2 == 0) size = -size;
            if (op <= 2) {
                vm.prank(agents[k]);
                try eng.trade(pids[k], bids[k], m, size, 0) {
                    fills++;
                } catch {}
            } else if (op == 3) {
                uint64 w = uint64(t) / eng.WINDOW();
                vm.prank(agents[k]);
                try eng.queueCross(pids[k], bids[k], m, size, 30) {} catch {}
                uint256 k2 = (k + 1) % 3;
                vm.prank(agents[k2]);
                try eng.queueCross(pids[k2], bids[k2], m, -size / 2, 30) {} catch {}
                t = uint256(w + 1) * eng.WINDOW(); // exactly the window close
                vm.warp(t);
                _px(BTC, btc, true);
                _px(NVDA, nvda, true);
                try eng.settleWindow(m, w) {
                    crosses++;
                } catch {}
            } else if (op == 4) {
                int256 bps = int256((r >> 48) % 401) - 200; // ±2%
                btc = btc * (10_000 + bps) / 10_000;
                nvda = nvda * (10_000 - bps) / 10_000;
                _adv(1 + (r >> 60) % 3600);
                _px(BTC, btc, true);
                _px(NVDA, nvda, true);
            } else if (op == 5) {
                try eng.enforce(pids[k], bids[k]) {} catch {}
            } else {
                _adv(7 days);
                _px(BTC, btc, true);
                _px(NVDA, nvda, true);
                try eng.crystallize(pids[k], bids[k]) {} catch {}
            }
            _check();
        }
        assertGt(fills + crosses, 0, "nothing traded");
    }
}
