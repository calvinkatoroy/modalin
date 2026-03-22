const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with account:", deployer.address);
  console.log("Account balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");

  // 1. Deploy SoulboundToken
  console.log("\n[1/6] Deploying SoulboundToken...");
  const SoulboundToken = await ethers.getContractFactory("SoulboundToken");
  const sbt = await SoulboundToken.deploy();
  await sbt.waitForDeployment();
  console.log("  SoulboundToken deployed to:", await sbt.getAddress());

  // 2. Deploy GuildSBT
  console.log("[2/6] Deploying GuildSBT...");
  const GuildSBT = await ethers.getContractFactory("GuildSBT");
  const guild = await GuildSBT.deploy();
  await guild.waitForDeployment();
  console.log("  GuildSBT deployed to:", await guild.getAddress());

  // 3. Deploy VouchRegistry
  console.log("[3/6] Deploying VouchRegistry...");
  const VouchRegistry = await ethers.getContractFactory("VouchRegistry");
  const vouchRegistry = await VouchRegistry.deploy();
  await vouchRegistry.waitForDeployment();
  console.log("  VouchRegistry deployed to:", await vouchRegistry.getAddress());

  // 4. Deploy ReputationEngine
  console.log("[4/6] Deploying ReputationEngine...");
  const ReputationEngine = await ethers.getContractFactory("ReputationEngine");
  const repEngine = await ReputationEngine.deploy(
    await sbt.getAddress(),
    await guild.getAddress(),
    await vouchRegistry.getAddress()
  );
  await repEngine.waitForDeployment();
  console.log("  ReputationEngine deployed to:", await repEngine.getAddress());

  // 5. Deploy InterestRateModel
  console.log("[5/6] Deploying InterestRateModel...");
  const InterestRateModel = await ethers.getContractFactory("InterestRateModel");
  const rateModel = await InterestRateModel.deploy(
    await sbt.getAddress(),
    await guild.getAddress()
  );
  await rateModel.waitForDeployment();
  console.log("  InterestRateModel deployed to:", await rateModel.getAddress());

  // 6. Deploy LoanEscrow
  console.log("[6/6] Deploying LoanEscrow...");
  const LoanEscrow = await ethers.getContractFactory("LoanEscrow");
  const escrow = await LoanEscrow.deploy(
    await sbt.getAddress(),
    await guild.getAddress(),
    await rateModel.getAddress(),
    await vouchRegistry.getAddress()
  );
  await escrow.waitForDeployment();
  console.log("  LoanEscrow deployed to:", await escrow.getAddress());

  // Wire up permissions
  console.log("\n[Setup] Wiring contract permissions...");

  // SoulboundToken: authorize ReputationEngine and LoanEscrow
  await sbt.setAuthorizedUpdater(await repEngine.getAddress(), true);
  await sbt.setAuthorizedUpdater(await escrow.getAddress(), true);
  console.log("  SoulboundToken: authorized ReputationEngine + LoanEscrow");

  // GuildSBT: authorize ReputationEngine and LoanEscrow
  await guild.setAuthorizedUpdater(await repEngine.getAddress(), true);
  await guild.setAuthorizedUpdater(await escrow.getAddress(), true);
  console.log("  GuildSBT: authorized ReputationEngine + LoanEscrow");

  // VouchRegistry: authorize LoanEscrow to slash vouchers
  await vouchRegistry.setLoanEscrow(await escrow.getAddress());
  console.log("  VouchRegistry: LoanEscrow set as slasher");

  // SoulboundToken: also allow deployer to issue SBTs during testing
  await sbt.setAuthorizedUpdater(deployer.address, true);
  console.log("  SoulboundToken: deployer authorized as issuer");

  console.log("\n=== Deployment Complete ===");
  console.log({
    SoulboundToken: await sbt.getAddress(),
    GuildSBT: await guild.getAddress(),
    VouchRegistry: await vouchRegistry.getAddress(),
    ReputationEngine: await repEngine.getAddress(),
    InterestRateModel: await rateModel.getAddress(),
    LoanEscrow: await escrow.getAddress(),
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
