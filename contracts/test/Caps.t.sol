// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.t.sol";
import {RefractEngine} from "../src/RefractEngine.sol";

/// R0 caps: Lens and per-Crystal deposits capped until the audit; exits never capped.
contract CapsTest is Base {
    function test_caps_defaultOff() public view {
        assertEq(eng.lensCap(), 0);
        assertEq(eng.crystalCap(), 0);
    }

    function test_caps_onlyAdmin() public {
        vm.prank(alice);
        vm.expectRevert(RefractEngine.NotAdmin.selector);
        eng.setCaps(1, 1);
    }

    function test_caps_crystalDeposit() public {
        vm.prank(admin);
        eng.setCaps(0, 50_000 * U);
        uint256 pid = _crystal(alice, 40_000 * U);
        _fund(alice, 20_000 * U);
        vm.startPrank(alice);
        vm.expectRevert(RefractEngine.OverCap.selector);
        eng.deposit(pid, 10_001 * U);
        eng.deposit(pid, 10_000 * U); // exactly at the cap
        eng.withdraw(pid, 50_000 * U); // exits ignore caps
        vm.stopPrank();
    }

    function test_caps_lensDeposit() public {
        // setUp seeded the Lens with 5M; cap it at 5.5M.
        vm.prank(admin);
        eng.setCaps(5_500_000 * U, 0);
        _fund(bob, 1_000_000 * U);
        vm.startPrank(bob);
        vm.expectRevert(RefractEngine.OverCap.selector);
        eng.lpDeposit(500_001 * U);
        uint256 shares = eng.lpDeposit(500_000 * U);
        eng.lpWithdraw(shares); // LP exits ignore caps
        vm.stopPrank();
    }
}
