// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MockUSDG} from "../src/testnet/MockUSDG.sol";
import {IPriceFeed} from "../src/interfaces/IPriceFeed.sol";

contract MockFeed is IPriceFeed {
    struct P {
        int256 price;
        uint64 ts;
        bool open;
    }

    mapping(bytes32 => P) public p;
    mapping(bytes32 => mapping(uint64 => P)) public h;

    error NoPriceAt();

    function set(bytes32 id, int256 price, uint64 ts, bool open) external {
        p[id] = P(price, ts, open);
        h[id][ts] = P(price, ts, open);
    }

    function priceAt(bytes32 id, uint64 ts) external view returns (int256, bool) {
        P memory x = h[id][ts];
        if (x.price == 0) revert NoPriceAt();
        return (x.price, x.open);
    }

    function latest(bytes32 id) external view returns (int256, uint64, bool) {
        P memory x = p[id];
        return (x.price, x.ts, x.open);
    }
}

/// @dev Stand-in for the Chainlink Data Streams verifier proxy: returns the report data unchanged.
contract MockVerifier {
    function s_feeManager() external pure returns (address) {
        return address(0);
    }

    function verify(bytes calldata payload, bytes calldata) external payable returns (bytes memory) {
        (, bytes memory reportData,,,) = abi.decode(payload, (bytes32[3], bytes, bytes32[], bytes32[], bytes32));
        return reportData;
    }
}
