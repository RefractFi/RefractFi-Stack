// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {RefractEngine} from "../src/RefractEngine.sol";

/// @notice M8: list NVDA, TSLA, SPY (v8 feeds with market status) on the testnet engine. Admin only.
///         Feed IDs are RefractFi testnet placeholders (deployments/testnet.json "feeds"); replace in M11.
///         Run: forge script script/ListEquities.s.sol --rpc-url $RPC_URL --broadcast --slow --gas-estimate-multiplier 300
contract ListEquities is Script {
    function _p(bytes32 feedId, int256 maxSkew) internal pure returns (RefractEngine.MarketParams memory) {
        // Kit NVDA parameters (test/Base.t.sol): 10x, 5% maintenance. skewScale = 25 × maxSkew as in the kit.
        // maxSkew sized so the 1M Lens covers its 20% reserve (~$0.8-1.1M net exposure per market).
        return RefractEngine.MarketParams({
            feedId: feedId, maxLev: 10e18, mmr: 0.05e18, takerFeeBps: 5, crossFeeBps: 1, skewScale: maxSkew * 25,
            maxFundingPerDay: 0.01e18, maxSkew: maxSkew, maxAge: 30
        });
    }

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        RefractEngine eng = RefractEngine(vm.parseJsonAddress(vm.readFile("../deployments/testnet.json"), ".contracts.RefractEngine.address"));
        vm.startBroadcast(pk);
        uint256 nvda = eng.listMarket(_p(0x0008dad289e1c73103a22dafe95a38cd898f5cabec7172c7e4edcf417a163aef, 5_000e18));
        uint256 tsla = eng.listMarket(_p(0x0008e8640e3e64633aba6a9a15e664b4b97648b9143529afeb5bb7fa497ca3eb, 2_500e18));
        uint256 spy = eng.listMarket(_p(0x0008f6a7b671a96a8b5140aeffd2ebd3fae2a18b7758a8265ddda7129df279f0, 1_500e18));
        vm.stopBroadcast();
        console.log("NVDA market", nvda);
        console.log("TSLA market", tsla);
        console.log("SPY market", spy);
    }
}
