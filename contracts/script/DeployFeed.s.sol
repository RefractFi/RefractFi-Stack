// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {StreamsFeed, IStreamsVerifierProxy} from "../src/StreamsFeed.sol";
import {TestnetVerifier} from "../src/testnet/TestnetVerifier.sol";

/// @notice M1: price path on testnet. TestnetVerifier (signer = pusher) + StreamsFeed.
///         Run: forge script script/DeployFeed.s.sol --rpc-url $RPC_URL --broadcast
contract DeployFeed is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        address pusher = vm.envAddress("PUSHER_ADDRESS");
        vm.startBroadcast(pk);
        // The verifier's admin (setSigner) is immutable: on mainnet pass ADMIN_ADDRESS = the admin Safe.
        TestnetVerifier ver = new TestnetVerifier(vm.envOr("ADMIN_ADDRESS", vm.addr(pk)), pusher);
        StreamsFeed feed = new StreamsFeed(IStreamsVerifierProxy(address(ver)), address(0));
        vm.stopBroadcast();
        console.log("TestnetVerifier", address(ver));
        console.log("StreamsFeed", address(feed));
    }
}
