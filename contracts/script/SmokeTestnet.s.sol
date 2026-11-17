// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {RefractEngine} from "../src/RefractEngine.sol";
import {MockUSDG} from "../src/testnet/MockUSDG.sol";

/// @notice M2 smoke run on testnet: owner opens a Crystal, deposits, sets a Beam; the agent trades at the live
///         pushed price; the owner flattens and withdraws everything. Checks USDG conservation after each step.
///         Run: forge script script/SmokeTestnet.s.sol --rpc-url $RPC_URL --broadcast --slow --gas-estimate-multiplier 300
///         Robinhood Chain is an Arbitrum-style rollup: forge's default gas margin let `flatten` run out of gas
///         (ReentrancySentryOOG) on the first run. viem/cast use eth_estimateGas and are fine.
///         The withdraw amount is computed in simulation; if the price moves before broadcast it can exceed the
///         real equity and revert. Rerun flatten/withdraw with cast if so.
contract SmokeTestnet is Script {
    RefractEngine eng;
    MockUSDG usdg;

    function run() external {
        uint256 ownerPk = vm.envUint("DEPLOYER_PK");
        uint256 agentPk = vm.envUint("AGENT_PK");
        address owner = vm.addr(ownerPk);
        string memory json = vm.readFile("../deployments/testnet.json");
        eng = RefractEngine(vm.parseJsonAddress(json, ".contracts.RefractEngine.address"));
        usdg = MockUSDG(vm.parseJsonAddress(json, ".contracts.MockUSDG.address"));
        uint256 dep = 15_000e6;

        vm.startBroadcast(ownerPk);
        usdg.mint(owner, dep);
        usdg.approve(address(eng), dep);
        uint256 pid = eng.openCrystal();
        eng.deposit(pid, dep);
        eng.setBeam(pid, 0, RefractEngine.BeamParams({
            agent: vm.addr(agentPk), until: uint64(block.timestamp + 1 days), marketMask: 3, softBps: 500,
            hardBps: 750, perfFeeBps: 2000, budget: 10_000e18, levCap: 10e18
        }));
        vm.stopBroadcast();
        _conserved(pid, "after deposit");

        vm.broadcast(agentPk);
        eng.trade(pid, 0, 0, 0.1e18, 0); // long 0.1 BTC against the Lens at the live mark
        (int256 eq, int256 im,) = eng.crystalRisk(pid);
        console.log("after trade: equity", uint256(eq) / 1e18, "IM", uint256(im) / 1e18);
        _conserved(pid, "after trade");

        uint256 before = usdg.balanceOf(owner);
        vm.startBroadcast(ownerPk);
        eng.flatten(pid);
        (eq,,) = eng.crystalRisk(pid);
        eng.withdraw(pid, uint256(eq) / 1e12);
        vm.stopBroadcast();
        _conserved(pid, "after flatten + withdraw");
        console.log("withdrawn USDG (6dp)", usdg.balanceOf(owner) - before, "of", dep);
        console.log("crystal id", pid);
    }

    function _conserved(uint256 pid, string memory when) internal view {
        int256 sum = eng.poolCash() + eng.protocolFees();
        for (uint256 i = 1; i <= eng.crystalCount(); ++i) {
            (,,, int256 c,,,,,) = eng.crystals(i);
            sum += c;
        }
        require(int256(usdg.balanceOf(address(eng))) * 1e12 == sum, string.concat("conservation broken ", when));
        console.log("conserved", when, pid);
    }
}
