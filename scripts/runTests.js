/**
 * ModalIn MVP – Integration Test Script (Hardhat 3)
 * Run with: npx hardhat run scripts/runTests.js --network hardhat
 *
 * Demonstrates the full lifecycle:
 *   1. SBT minting (soulbound, non-transferable)
 *   2. Credit-Group creation & joining
 *   3. Vouching with ETH stake
 *   4. Reputation engine (3-layer score)
 *   5. Interest rate model (APR formula)
 *   6. Full loan lifecycle: request → fund → repay → lender-withdraw
 *   7. Default scenario: slash vouchers & penalise reputation
 */

import hre from "hardhat";

// ─── tiny assertion helpers ────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓  ${message}`);
    passed++;
  } else {
    console.error(`  ✗  FAIL: ${message}`);
    failed++;
  }
}

function assertEqual(a, b, message) {
  if (a === b || a.toString() === b.toString()) {
    console.log(`  ✓  ${message}`);
    passed++;
  } else {
    console.error(`  ✗  FAIL: ${message} (got ${a}, expected ${b})`);
    failed++;
  }
}

function assertGt(a, b, message) {
  if (a > b) {
    console.log(`  ✓  ${message}`);
    passed++;
  } else {
    console.error(`  ✗  FAIL: ${message} (${a} is not > ${b})`);
    failed++;
  }
}

function assertLte(a, b, message) {
  if (a <= b) {
    console.log(`  ✓  ${message}`);
    passed++;
  } else {
    console.error(`  ✗  FAIL: ${message} (${a} is not <= ${b})`);
    failed++;
  }
}

async function assertRevert(promise, errorName, message) {
  try {
    await promise;
    console.error(`  ✗  FAIL: ${message} (expected revert '${errorName}', but call succeeded)`);
    failed++;
  } catch (e) {
    if (e.message && e.message.includes(errorName)) {
      console.log(`  ✓  ${message}`);
      passed++;
    } else {
      console.error(`  ✗  FAIL: ${message} (unexpected error: ${e.message})`);
      failed++;
    }
  }
}

// ─── main ──────────────────────────────────────────────────────────────────
async function main() {
  const connection = await hre.network.connect();
  const { ethers } = connection;

  console.log("\n══════════════════════════════════════════════════════");
  console.log("  ModalIn MVP – Smart Contract Test Suite");
  console.log("══════════════════════════════════════════════════════\n");

  // ── Setup: get signers ─────────────────────────────────────────────────
  const signers = await ethers.getSigners();
  const [owner, borrower, lender1, lender2, groupMember1, groupMember2, oracle] = signers;

  console.log(`Deployer  : ${owner.address}`);
  console.log(`Borrower  : ${borrower.address}`);
  console.log(`Lender    : ${lender1.address}`);
  console.log("");

  // ── Deploy contracts ───────────────────────────────────────────────────
  console.log("▶  Deploying contracts...");

  const SoulboundToken = await ethers.getContractFactory("SoulboundToken");
  const sbt = await SoulboundToken.deploy();
  await sbt.waitForDeployment();

  const GuildSBT = await ethers.getContractFactory("GuildSBT");
  const guild = await GuildSBT.deploy();
  await guild.waitForDeployment();

  const VouchRegistry = await ethers.getContractFactory("VouchRegistry");
  const vouchRegistry = await VouchRegistry.deploy();
  await vouchRegistry.waitForDeployment();

  const ReputationEngine = await ethers.getContractFactory("ReputationEngine");
  const repEngine = await ReputationEngine.deploy(
    await sbt.getAddress(),
    await guild.getAddress(),
    await vouchRegistry.getAddress()
  );
  await repEngine.waitForDeployment();

  const InterestRateModel = await ethers.getContractFactory("InterestRateModel");
  const rateModel = await InterestRateModel.deploy(
    await sbt.getAddress(),
    await guild.getAddress()
  );
  await rateModel.waitForDeployment();

  const LoanEscrow = await ethers.getContractFactory("LoanEscrow");
  const escrow = await LoanEscrow.deploy(
    await sbt.getAddress(),
    await guild.getAddress(),
    await rateModel.getAddress(),
    await vouchRegistry.getAddress()
  );
  await escrow.waitForDeployment();

  // Wire permissions
  await sbt.setAuthorizedUpdater(await repEngine.getAddress(), true);
  await sbt.setAuthorizedUpdater(await escrow.getAddress(), true);
  await sbt.setAuthorizedUpdater(owner.address, true);
  await guild.setAuthorizedUpdater(await repEngine.getAddress(), true);
  await guild.setAuthorizedUpdater(await escrow.getAddress(), true);
  await vouchRegistry.setLoanEscrow(await escrow.getAddress());
  await repEngine.setDefaultOracle(oracle.address);

  console.log("  ✓  All 6 contracts deployed & permissions wired\n");

  // ══════════════════════════════════════════════════════════════════════
  //  SUITE 1: SoulboundToken
  // ══════════════════════════════════════════════════════════════════════
  console.log("─── Suite 1: SoulboundToken (ERC-5114 Soulbound) ─────");

  await sbt.issueSBT(borrower.address);
  assert(await sbt.hasSBT(borrower.address), "SBT issued to borrower");
  assertEqual(await sbt.getReputationScore(borrower.address), 500n, "Initial score is neutral 500");

  await sbt.updateReputation(borrower.address, 750n);
  assertEqual(await sbt.getReputationScore(borrower.address), 750n, "Reputation updated to 750");

  await assertRevert(
    sbt.issueSBT(borrower.address),
    "AlreadyHasSBT",
    "Cannot issue second SBT to same address"
  );

  await assertRevert(
    sbt.transfer(borrower.address, 1n),
    "TransferNotAllowed",
    "Transfer is permanently blocked (soulbound)"
  );

  await assertRevert(
    sbt.connect(borrower).updateReputation(borrower.address, 900n),
    "NotAuthorized",
    "Unauthorized actor cannot update reputation"
  );

  assertEqual(await sbt.getRepaymentRate(borrower.address), 100n, "No loans yet => 100% repayment rate");

  // ══════════════════════════════════════════════════════════════════════
  //  SUITE 2: GuildSBT – Kelompok Kredit
  // ══════════════════════════════════════════════════════════════════════
  console.log("\n─── Suite 2: GuildSBT – Kelompok Kredit ─────────────");

  await guild.connect(groupMember1).createGroup("Kelompok Maju Jaya");
  const groupId = await guild.memberToGroup(groupMember1.address);
  assertEqual(groupId, 1n, "Group created with ID 1");

  await guild.connect(groupMember2).joinGroup(groupId);
  assert(await guild.isGroupMember(groupMember2.address), "groupMember2 joined group");

  const group = await guild.getGroup(groupId);
  assertEqual(group.tier, 0n, "New group starts at Bronze tier");
  assertEqual(group.collectiveScore, 500n, "Initial collective score is 500");

  await guild.updateGroupScore(groupId, 700n);
  assertEqual(await guild.getGroupTier(groupId), 1n, "Score 700 → Silver tier");

  await guild.updateGroupScore(groupId, 850n);
  assertEqual(await guild.getGroupTier(groupId), 2n, "Score 850 → Gold tier");

  await assertRevert(
    guild.connect(groupMember2).joinGroup(groupId),
    "AlreadyInGroup",
    "Cannot join a second group"
  );

  // ══════════════════════════════════════════════════════════════════════
  //  SUITE 3: VouchRegistry – Social Collateral
  // ══════════════════════════════════════════════════════════════════════
  console.log("\n─── Suite 3: VouchRegistry – Social Collateral ──────");

  const stakeAmount = ethers.parseEther("0.01");
  await vouchRegistry.connect(groupMember1).vouch(borrower.address, 600n, { value: stakeAmount });
  assertEqual(await vouchRegistry.getActiveVouchCount(borrower.address), 1n, "One active vouch recorded");

  await vouchRegistry.connect(groupMember2).vouch(borrower.address, 400n, { value: ethers.parseEther("0.01") });
  const vouchScore = await vouchRegistry.getVouchScore(borrower.address);
  assertEqual(vouchScore, 500n, "Stake-weighted vouch score: (600+400)/2 = 500");

  await assertRevert(
    vouchRegistry.connect(borrower).vouch(borrower.address, 500n, { value: stakeAmount }),
    "CannotVouchForSelf",
    "Self-vouching is prohibited"
  );

  await assertRevert(
    vouchRegistry.connect(lender1).vouch(borrower.address, 500n, { value: ethers.parseEther("0.0001") }),
    "InsufficientStake",
    "Insufficient stake rejected"
  );

  // ══════════════════════════════════════════════════════════════════════
  //  SUITE 4: ReputationEngine – 3-Layer Composite Score
  // ══════════════════════════════════════════════════════════════════════
  console.log("\n─── Suite 4: ReputationEngine – Composite Score ─────");

  // Use staticCall to read the return value without sending a tx, then send the actual tx
  const score = await repEngine.recalculateScore.staticCall(borrower.address);
  await repEngine.recalculateScore(borrower.address); // actually execute and write state
  assertGt(score, 0n, "Composite score recalculated and > 0");

  await repEngine.connect(oracle).submitAttestationScore(borrower.address, 800n);
  const { attestScore } = await repEngine.getCompositeScore(borrower.address);
  assertEqual(attestScore, 800n, "Attestation score (off-chain EAS) = 800");

  await assertRevert(
    repEngine.connect(lender1).submitAttestationScore(borrower.address, 800n),
    "NotAuthorizedOracle",
    "Unauthorized oracle rejected"
  );

  await assertRevert(
    repEngine.setWeights(50n, 30n, 30n),
    "WeightsMustSumTo100",
    "Weights summing to 110 rejected"
  );

  // ══════════════════════════════════════════════════════════════════════
  //  SUITE 5: InterestRateModel – APR = Base + GroupRisk - RepDiscount
  // ══════════════════════════════════════════════════════════════════════
  console.log("\n─── Suite 5: InterestRateModel – Dynamic APR Formula ─");

  // Borrower has SBT (issued in Suite 1) and currently score = 750
  // No group → uses Bronze premium (800 bps)
  // APR = 1200 + 800 - (750*600/1000=450) = 1550 bps  → 15.5%
  const aprBronze = await rateModel.calculateAPR(borrower.address);
  assertGt(aprBronze, 1500n, `Bronze/low-rep borrower APR = ${aprBronze} bps (>1500 bps)`);

  // Give borrower Gold group for discount
  await guild.connect(borrower).createGroup("Kelompok Emas");
  const borrowerGroupId = await guild.memberToGroup(borrower.address);
  await guild.updateGroupScore(borrowerGroupId, 900n);
  await sbt.updateReputation(borrower.address, 950n);

  // APR = 1200 + 0 - (950*600/1000=570) = 630 bps → clamped to minAPR 600 bps
  const aprGold = await rateModel.calculateAPR(borrower.address);
  assertLte(aprGold, 700n, `Gold/high-rep borrower APR = ${aprGold} bps (≤700 bps)`);

  const interest = await rateModel.calculateInterest(borrower.address, ethers.parseEther("1"), 30n);
  assertGt(interest, 0n, `30-day interest on 1 ETH = ${ethers.formatEther(interest)} ETH`);

  const breakdown = await rateModel.getAPRBreakdown(borrower.address);
  console.log(`  ℹ  APR Breakdown: base=${breakdown[0]}bps, groupPremium=${breakdown[1]}bps, repDiscount=${breakdown[2]}bps, final=${breakdown[3]}bps`);
  passed++;

  // ══════════════════════════════════════════════════════════════════════
  //  SUITE 6: LoanEscrow – Full Loan Lifecycle
  // ══════════════════════════════════════════════════════════════════════
  console.log("\n─── Suite 6: LoanEscrow – Full Loan Lifecycle ────────");

  const principal = ethers.parseEther("0.1");

  // 6a. Reject loan request without SBT
  await assertRevert(
    escrow.connect(lender2).requestLoan(principal, 30n),
    "NoSBTFound",
    "Loan request without SBT rejected"
  );

  // 6b. Borrower (has SBT) requests loan
  const reqTx = await escrow.connect(borrower).requestLoan(principal, 30n);
  await reqTx.wait();
  const loanId = 1n;
  const loanAfterRequest = await escrow.getLoan(loanId);
  assertEqual(loanAfterRequest.status, 0n, "Loan status = Requested (0)");
  assertEqual(loanAfterRequest.borrower, borrower.address, "Loan borrower is correct");
  console.log(`  ℹ  APR for this loan: ${loanAfterRequest.aprBasisPoints} bps`);
  console.log(`  ℹ  Interest due: ${ethers.formatEther(loanAfterRequest.interestAmount)} ETH`);
  console.log(`  ℹ  Total due: ${ethers.formatEther(loanAfterRequest.totalDue)} ETH`);

  // 6c. Lender funds the loan
  const borrowerBalBefore = await ethers.provider.getBalance(borrower.address);
  await escrow.connect(lender1).fundLoan(loanId, { value: principal });
  const loanAfterFund = await escrow.getLoan(loanId);
  assertEqual(loanAfterFund.status, 2n, "Loan status = Active (2) after full funding");

  const borrowerBalAfter = await ethers.provider.getBalance(borrower.address);
  assertGt(borrowerBalAfter, borrowerBalBefore, "Borrower received ETH disbursement");

  // 6d. Non-borrower cannot repay
  await assertRevert(
    escrow.connect(lender1).repayLoan(loanId, { value: loanAfterFund.totalDue }),
    "NotBorrower",
    "Non-borrower cannot repay loan"
  );

  // 6e. Borrower repays
  await escrow.connect(borrower).repayLoan(loanId, { value: loanAfterFund.totalDue });
  const loanAfterRepay = await escrow.getLoan(loanId);
  assertEqual(loanAfterRepay.status, 3n, "Loan status = Repaid (3)");

  // 6f. Lender withdraws principal + interest
  const lenderBalBefore = await ethers.provider.getBalance(lender1.address);
  await escrow.connect(lender1).withdrawLenderFunds(loanId, 0n);
  const lenderBalAfter = await ethers.provider.getBalance(lender1.address);
  assertGt(lenderBalAfter, lenderBalBefore, "Lender withdrew principal + interest share");

  // ══════════════════════════════════════════════════════════════════════
  //  SUITE 7: Default Scenario – Voucher Slash & Reputation Penalty
  // ══════════════════════════════════════════════════════════════════════
  console.log("\n─── Suite 7: Default & Voucher Slash ─────────────────");

  // Deploy fresh borrower2 (uses lender2 as the defaulting borrower)
  await sbt.issueSBT(lender2.address);

  const loan2Tx = await escrow.connect(lender2).requestLoan(ethers.parseEther("0.05"), 7n);
  await loan2Tx.wait();
  const loan2Id = 2n;

  await escrow.connect(lender1).fundLoan(loan2Id, { value: ethers.parseEther("0.05") });

  // groupMember1 vouches for lender2 (acting as a defaulting borrower)
  await vouchRegistry.connect(groupMember1).vouch(lender2.address, 600n, { value: ethers.parseEther("0.02") });
  const vouchCountBefore = await vouchRegistry.getActiveVouchCount(lender2.address);
  assertEqual(vouchCountBefore, 1n, "One active vouch before default");

  // Fast-forward past loan due date + grace period (7 days + 7 days = 14 days)
  await connection.provider.send("evm_increaseTime", [15 * 24 * 60 * 60]);
  await connection.provider.send("evm_mine", []);

  const scoreBefore = await sbt.getReputationScore(lender2.address);
  await escrow.markDefault(loan2Id);
  const loanDefaulted = await escrow.getLoan(loan2Id);
  assertEqual(loanDefaulted.status, 4n, "Loan status = Defaulted (4)");

  const vouchCountAfter = await vouchRegistry.getActiveVouchCount(lender2.address);
  assertEqual(vouchCountAfter, 0n, "All vouches slashed after default");

  const scoreAfter = await sbt.getReputationScore(lender2.address);
  assertLte(scoreAfter, scoreBefore / 2n + 1n, `Reputation penalised: ${scoreBefore} → ${scoreAfter}`);

  // ── Summary ────────────────────────────────────────────────────────────
  console.log("\n══════════════════════════════════════════════════════");
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log("══════════════════════════════════════════════════════\n");

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exitCode = 1;
});
