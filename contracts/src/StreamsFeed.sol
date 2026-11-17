// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPriceFeed} from "./interfaces/IPriceFeed.sol";

/// @dev Chainlink Data Streams verifier proxy (Robinhood Chain mainnet: 0xcE73c8ad08CBDEaCa6078BF0627C8fe0a9a536E7).
interface IStreamsVerifierProxy {
    function verify(bytes calldata payload, bytes calldata parameterPayload) external payable returns (bytes memory);
    function s_feeManager() external view returns (address);
}

interface IStreamsFeeManager {
    struct Asset {
        address assetAddress;
        uint256 amount;
    }

    function getFeeAndReward(address subscriber, bytes memory unverifiedReport, address quoteAddress)
        external
        returns (Asset memory fee, Asset memory reward, uint256 discount);
    function i_rewardManager() external view returns (address);
}

/// @title StreamsFeed
/// @notice Pull-model price store for Chainlink Data Streams reports. Anyone may push signed reports; each is verified
///         by the Chainlink verifier proxy before it is stored. Supports schema v3 (24/7 crypto) and v8 (RWA, with
///         market status). Only newer observations replace stored ones.
/// @dev Perps reference the underlying instrument's price, never a Stock Token balance, so no ERC-8056 UI multiplier
///      is ever applied here.
contract StreamsFeed is IPriceFeed {
    using SafeERC20 for IERC20;

    struct Stored {
        int192 price;
        uint32 observedAt;
        uint32 status; // v8: 0 unknown, 1 closed, 2 open (U: confirm enum per feed). v3 stores 2.
    }

    IStreamsVerifierProxy public immutable verifier;
    address public immutable feeToken; // LINK on chains where a fee manager is set; ignored otherwise
    mapping(bytes32 => Stored) internal stored;
    mapping(bytes32 => mapping(uint64 => Stored)) internal history;

    event Pushed(bytes32 indexed feedId, int192 price, uint32 observedAt, uint32 status);

    error UnknownSchema(uint16 version);
    error NoPrice(bytes32 feedId);
    error NoPriceAt(bytes32 feedId, uint64 ts);

    constructor(IStreamsVerifierProxy verifier_, address feeToken_) {
        verifier = verifier_;
        feeToken = feeToken_;
    }

    function push(bytes[] calldata fullReports) external {
        address feeManager = verifier.s_feeManager();
        for (uint256 i; i < fullReports.length; ++i) {
            bytes memory param;
            if (feeManager != address(0)) {
                (, bytes memory reportData,,,) =
                    abi.decode(fullReports[i], (bytes32[3], bytes, bytes32[], bytes32[], bytes32));
                (IStreamsFeeManager.Asset memory fee,,) =
                    IStreamsFeeManager(feeManager).getFeeAndReward(address(this), reportData, feeToken);
                IERC20(feeToken).forceApprove(IStreamsFeeManager(feeManager).i_rewardManager(), fee.amount);
                param = abi.encode(feeToken);
            }
            bytes memory verified = verifier.verify(fullReports[i], param);
            _store(verified);
        }
    }

    function _store(bytes memory r) internal {
        bytes32 feedId;
        assembly {
            feedId := mload(add(r, 32))
        }
        uint16 version = uint16(uint256(feedId) >> 240);
        int192 price;
        uint32 observedAt;
        uint32 status;
        if (version == 3) {
            (, , uint32 obs, , , , int192 p, , ) =
                abi.decode(r, (bytes32, uint32, uint32, uint192, uint192, uint32, int192, int192, int192));
            (price, observedAt, status) = (p, obs, 2);
        } else if (version == 8) {
            (, , uint32 obs, , , , , int192 mid, uint32 ms) =
                abi.decode(r, (bytes32, uint32, uint32, uint192, uint192, uint32, uint64, int192, uint32));
            (price, observedAt, status) = (mid, obs, ms);
        } else {
            revert UnknownSchema(version);
        }
        if (price <= 0) return;
        Stored memory rec = Stored(price, observedAt, status);
        if (history[feedId][observedAt].price == 0) history[feedId][observedAt] = rec;
        if (observedAt > stored[feedId].observedAt) {
            stored[feedId] = rec;
            emit Pushed(feedId, price, observedAt, status);
        }
    }

    function latest(bytes32 feedId) external view returns (int256, uint64, bool) {
        Stored memory s = stored[feedId];
        if (s.price <= 0) revert NoPrice(feedId);
        return (int256(s.price), s.observedAt, s.status == 2);
    }

    /// @dev Crossing windows settle at the report observed exactly at the window close, so no settler can pick
    ///      a favourable price among several reports.
    function priceAt(bytes32 feedId, uint64 ts) external view returns (int256, bool) {
        Stored memory s = history[feedId][ts];
        if (s.price <= 0) revert NoPriceAt(feedId, ts);
        return (int256(s.price), s.status == 2);
    }
}
