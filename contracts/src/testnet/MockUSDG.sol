// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice TESTNET ONLY. Stand-in for USDG (6 decimals, no permit, like the real token). Anyone can mint: it is the
///         testnet faucet.
contract MockUSDG is ERC20 {
    constructor() ERC20("Global Dollar (testnet mock)", "USDG") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}
