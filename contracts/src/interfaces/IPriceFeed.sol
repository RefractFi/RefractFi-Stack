// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Latest verified price for a feed. Prices are 18-decimal USD.
interface IPriceFeed {
    /// @return priceWad   18-decimal price (> 0)
    /// @return observedAt observation timestamp of the report the price came from
    /// @return marketOpen false while the underlying venue is closed (equities off-hours); always true for 24/7 assets
    function latest(bytes32 feedId) external view returns (int256 priceWad, uint64 observedAt, bool marketOpen);

    /// @notice The verified price observed at exactly `ts`. Reverts if no such report was pushed.
    function priceAt(bytes32 feedId, uint64 ts) external view returns (int256 priceWad, bool marketOpen);
}
