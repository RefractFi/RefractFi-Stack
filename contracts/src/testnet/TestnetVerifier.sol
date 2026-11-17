// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title TestnetVerifier
/// @notice TESTNET ONLY. Stand-in for the Chainlink Data Streams verifier proxy while the real testnet proxy and API
///         access are unavailable. Same `verify` / `s_feeManager` interface, so StreamsFeed is unchanged.
///         A report is accepted only if `signer` signed keccak256(reportData) (EIP-191), carried in the payload's
///         first rs / ss entries with v in rawVs. Without this, anyone could push any price on a public testnet.
contract TestnetVerifier {
    address public immutable admin;
    address public signer;

    event SignerSet(address signer);

    error NotAdmin();
    error BadSigner(address recovered);

    constructor(address admin_, address signer_) {
        admin = admin_;
        signer = signer_;
        emit SignerSet(signer_);
    }

    /// @dev Rotate the pusher key without redeploying StreamsFeed and the engine (both hold this address immutably).
    function setSigner(address s) external {
        if (msg.sender != admin) revert NotAdmin();
        signer = s;
        emit SignerSet(s);
    }

    function s_feeManager() external pure returns (address) {
        return address(0);
    }

    function verify(bytes calldata payload, bytes calldata) external payable returns (bytes memory reportData) {
        bytes32[] memory rs;
        bytes32[] memory ss;
        bytes32 rawVs;
        (, reportData, rs, ss, rawVs) = abi.decode(payload, (bytes32[3], bytes, bytes32[], bytes32[], bytes32));
        if (rs.length == 0 || ss.length == 0) revert BadSigner(address(0));
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(keccak256(reportData));
        address got = ECDSA.recover(digest, uint8(uint256(rawVs)), rs[0], ss[0]);
        if (got != signer) revert BadSigner(got);
    }
}
