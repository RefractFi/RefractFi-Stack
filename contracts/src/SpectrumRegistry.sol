// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title SpectrumRegistry
/// @notice Public listings for agents that accept beams. Discovery only: the engine never reads it, so a listing can
///         never move funds. Rankings come from beam records the indexer rebuilds from engine events.
contract SpectrumRegistry {
    uint16 public constant MAX_PERF_FEE_BPS = 3000;

    struct Listing {
        uint16 perfFeeBps;
        bool active;
        uint64 listedAt;
        string uri; // strategy card: markets, style, max leverage, ERC-8004 identity
    }

    mapping(address => Listing) public listings;

    event Listed(address indexed agent, uint16 perfFeeBps, string uri);
    event Delisted(address indexed agent);

    error FeeTooHigh();

    function list(uint16 perfFeeBps, string calldata uri) external {
        if (perfFeeBps > MAX_PERF_FEE_BPS) revert FeeTooHigh();
        listings[msg.sender] = Listing(perfFeeBps, true, uint64(block.timestamp), uri);
        emit Listed(msg.sender, perfFeeBps, uri);
    }

    function delist() external {
        listings[msg.sender].active = false;
        emit Delisted(msg.sender);
    }
}
