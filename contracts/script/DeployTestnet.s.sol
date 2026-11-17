// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {RefractEngine} from "../src/RefractEngine.sol";
import {IPriceFeed} from "../src/interfaces/IPriceFeed.sol";
import {SpectrumRegistry} from "../src/SpectrumRegistry.sol";
import {TraceRoots} from "../src/TraceRoots.sol";
import {MockUSDG} from "../src/testnet/MockUSDG.sol";

/// @notice Shared engine setup: deploy, list BTC/ETH, set R0 caps, seed the Lens. Broadcast must be active.
abstract contract EngineSetup is Script {
    // Must match deployments/testnet.json "feeds".
    bytes32 constant BTC = 0x00037da06d56d083fe599397a4769a042d63aa73dc4ef57709d31e9971a5b439;
    bytes32 constant ETH = 0x000359843a543ee2fe414dc14c7e7920ef10f4372990b79d6361cdc0dd1ba782;
    uint256 constant LENS_SEED = 1_000_000e6;
    uint256 constant LENS_CAP = 2_000_000e6; // overview §6 R0 gate
    uint256 constant CRYSTAL_CAP = 50_000e6;

    function _engine(MockUSDG usdg, address feed, address admin, address guardian) internal returns (RefractEngine eng) {
        eng = new RefractEngine(IERC20(address(usdg)), IPriceFeed(feed), admin, guardian);
        // Kit parameters (test/Base.t.sol) with testnet-sized skew caps: the 1M Lens seed covers its 20% reserve
        // at 50 BTC (~$3.6M) and 1,000 ETH (~$2M). maxAge 30 s suits the pusher's 20 s freshness cadence.
        eng.listMarket(RefractEngine.MarketParams({
            feedId: BTC, maxLev: 20e18, mmr: 0.025e18, takerFeeBps: 5, crossFeeBps: 1, skewScale: 10_000e18,
            maxFundingPerDay: 0.01e18, maxSkew: 50e18, maxAge: 30
        }));
        eng.listMarket(RefractEngine.MarketParams({
            feedId: ETH, maxLev: 20e18, mmr: 0.025e18, takerFeeBps: 5, crossFeeBps: 1, skewScale: 200_000e18,
            maxFundingPerDay: 0.01e18, maxSkew: 1_000e18, maxAge: 30
        }));
        eng.setCaps(LENS_CAP, CRYSTAL_CAP);
        usdg.mint(admin, LENS_SEED);
        usdg.approve(address(eng), LENS_SEED);
        eng.lpDeposit(LENS_SEED);
        console.log("RefractEngine", address(eng));
    }
}

/// @notice Full testnet deploy (M2), wired to the M1 StreamsFeed the pusher already feeds.
///         Run: forge script script/DeployTestnet.s.sol --rpc-url $RPC_URL --broadcast --slow --gas-estimate-multiplier 300
contract DeployTestnet is EngineSetup {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        string memory json = vm.readFile("../deployments/testnet.json");
        address feed = vm.parseJsonAddress(json, ".contracts.StreamsFeed.address");
        vm.startBroadcast(pk);
        MockUSDG usdg = new MockUSDG();
        _engine(usdg, feed, vm.addr(pk), vm.envAddress("GUARDIAN_ADDRESS"));
        SpectrumRegistry reg = new SpectrumRegistry();
        TraceRoots roots = new TraceRoots(vm.envAddress("POSTER_ADDRESS"));
        vm.stopBroadcast();
        console.log("MockUSDG", address(usdg));
        console.log("SpectrumRegistry", address(reg));
        console.log("TraceRoots", address(roots));
    }
}

/// @notice Engine-only redeploy (e.g. after an engine change). Reuses MockUSDG, StreamsFeed, Spectrum and TraceRoots.
///         Run: forge script script/DeployTestnet.s.sol:RedeployEngine --rpc-url $RPC_URL --broadcast --slow --gas-estimate-multiplier 300
contract RedeployEngine is EngineSetup {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        string memory json = vm.readFile("../deployments/testnet.json");
        vm.startBroadcast(pk);
        _engine(
            MockUSDG(vm.parseJsonAddress(json, ".contracts.MockUSDG.address")),
            vm.parseJsonAddress(json, ".contracts.StreamsFeed.address"),
            vm.addr(pk),
            vm.envAddress("GUARDIAN_ADDRESS")
        );
        vm.stopBroadcast();
    }
}
