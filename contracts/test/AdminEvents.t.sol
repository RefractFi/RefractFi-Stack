// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.t.sol";
import {RefractEngine} from "../src/RefractEngine.sol";

/// Every admin/guardian change is visible on-chain (Slither events-access / events-maths; M7 §2 mainnet to-do).
contract AdminEventsTest is Base {
    function test_adminSetters_emit() public {
        vm.startPrank(admin);
        vm.expectEmit(address(eng));
        emit RefractEngine.ProtocolShareSet(1000);
        eng.setProtocolShare(1000);

        vm.expectEmit(address(eng));
        emit RefractEngine.OpensPausedSet(true);
        eng.pauseOpens(true);

        vm.expectEmit(address(eng));
        emit RefractEngine.MarketSet(0);
        eng.setMarket(
            0,
            RefractEngine.MarketParams({
                feedId: BTC,
                maxLev: 10e18,
                mmr: 0.025e18,
                takerFeeBps: 5,
                crossFeeBps: 1,
                skewScale: 10_000e18,
                maxFundingPerDay: 0.01e18,
                maxSkew: 500e18,
                maxAge: 60
            })
        );

        vm.expectEmit(address(eng));
        emit RefractEngine.ProtocolFeesTaken(alice, 0);
        eng.takeProtocolFees(alice);

        vm.expectEmit(address(eng));
        emit RefractEngine.GuardianSet(bob);
        eng.setGuardian(bob);

        vm.expectEmit(address(eng));
        emit RefractEngine.AdminSet(bob);
        eng.setAdmin(bob);
        vm.stopPrank();

        vm.prank(admin);
        vm.expectRevert(RefractEngine.NotAdmin.selector);
        eng.setAdmin(admin); // the old admin is out
    }
}
