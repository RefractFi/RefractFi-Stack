// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @title TraceRoots
/// @notice One Merkle root per epoch over agent decision traces (what the beam saw, proposed, what the engine did).
///         Epochs are strictly sequential and roots can never be rewritten.
contract TraceRoots {
    address public immutable poster;
    uint64 public lastEpoch;
    mapping(uint64 => bytes32) public rootOf;
    mapping(uint64 => uint32) public leavesOf;

    event Committed(uint64 indexed epoch, bytes32 root, uint32 leaves);

    error NotPoster();
    error OutOfOrder(uint64 expected, uint64 got);

    constructor(address poster_) {
        poster = poster_;
    }

    function commit(uint64 epoch, bytes32 root, uint32 leaves) external {
        if (msg.sender != poster) revert NotPoster();
        if (epoch != lastEpoch + 1) revert OutOfOrder(lastEpoch + 1, epoch);
        lastEpoch = epoch;
        rootOf[epoch] = root;
        leavesOf[epoch] = leaves;
        emit Committed(epoch, root, leaves);
    }

    /// @dev Leaves are keccak256 of the canonical trace JSON; pairs are hashed sorted (OpenZeppelin convention).
    function proves(uint64 epoch, bytes32 leaf, bytes32[] calldata proof) external view returns (bool) {
        bytes32 root = rootOf[epoch];
        return root != bytes32(0) && MerkleProof.verifyCalldata(proof, root, leaf);
    }
}
