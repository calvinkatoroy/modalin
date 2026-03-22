/**
 * ModalIn MVP – Unit & Integration Tests (Node.js built-in test runner)
 *
 * This test file uses the Node.js 18+ built-in `node:test` module and
 * `node:assert` – no external test-framework dependency required.
 *
 * Run via: npx hardhat run scripts/runTests.js --network hardhat
 * (The canonical test runner for Hardhat 3 is the run-script approach.
 *  This file mirrors the same tests for documentation purposes.)
 *
 * Full suite: 38 test assertions across 7 suites covering
 *   SoulboundToken · GuildSBT · VouchRegistry · ReputationEngine
 *   InterestRateModel · LoanEscrow (lifecycle) · Default & slash scenario
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import hardhatEthersPlugin from "@nomicfoundation/hardhat-ethers";

// ── Shared state across all suites ─────────────────────────────────────────
let ethers, owner, borrower, lender1, lender2, groupMember1, groupMember2, oracle;
let sbt, guild, vouchRegistry, repEngine, rateModel, escrow;
let connection;

async function deployAll() {
  const hre = await createHardhatRuntimeEnvironment(
    {
      plugins: [hardhatEthersPlugin],
      solidity: {
        version: "0.8.20",
        settings: { optimizer: { enabled: true, runs: 200 } },
      },
      networks: {
        hardhat: { type: "edr-simulated", chainId: 31337 },
      },
      paths: {
        sources: "./contracts",
        tests: "./test",
        cache: "./cache",
        artifacts: "./artifacts",
      },
    },
    {}
  );

  connection = await hre.network.connect();
  ethers = connection.ethers;

  const signers = await ethers.getSigners();
  [owner, borrower, lender1, lender2, groupMember1, groupMember2, oracle] = signers;

  // Deploy
  const SBTFactory = await ethers.getContractFactory("SoulboundToken");
  sbt = await SBTFactory.deploy();
  await sbt.waitForDeployment();

  const GuildFactory = await ethers.getContractFactory("GuildSBT");
  guild = await GuildFactory.deploy();
  await guild.waitForDeployment();

  const VouchFactory = await ethers.getContractFactory("VouchRegistry");
  vouchRegistry = await VouchFactory.deploy();
  await vouchRegistry.waitForDeployment();

  const RepFactory = await ethers.getContractFactory("ReputationEngine");
  repEngine = await RepFactory.deploy(
    await sbt.getAddress(),
    await guild.getAddress(),
    await vouchRegistry.getAddress()
  );
  await repEngine.waitForDeployment();

  const RateFactory = await ethers.getContractFactory("InterestRateModel");
  rateModel = await RateFactory.deploy(
    await sbt.getAddress(),
    await guild.getAddress()
  );
  await rateModel.waitForDeployment();

  const EscrowFactory = await ethers.getContractFactory("LoanEscrow");
  escrow = await EscrowFactory.deploy(
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
}

// ── Suite 1: SoulboundToken ────────────────────────────────────────────────
describe("SoulboundToken", () => {
  before(deployAll);

  it("issues an SBT to a new borrower", async () => {
    await sbt.issueSBT(borrower.address);
    assert.equal(await sbt.hasSBT(borrower.address), true);
  });

  it("starts with a neutral reputation score of 500", async () => {
    assert.equal(await sbt.getReputationScore(borrower.address), 500n);
  });

  it("updates reputation score", async () => {
    await sbt.updateReputation(borrower.address, 750n);
    assert.equal(await sbt.getReputationScore(borrower.address), 750n);
  });

  it("reverts when issuing a second SBT to same address", async () => {
    await assert.rejects(sbt.issueSBT(borrower.address), /AlreadyHasSBT/);
  });

  it("blocks transfers (soulbound)", async () => {
    await assert.rejects(sbt.transfer(borrower.address, 1n), /TransferNotAllowed/);
  });

  it("reverts on unauthorized updater", async () => {
    await assert.rejects(
      sbt.connect(borrower).updateReputation(borrower.address, 900n),
      /NotAuthorized/
    );
  });

  it("returns 100% repayment rate with no loan history", async () => {
    assert.equal(await sbt.getRepaymentRate(borrower.address), 100n);
  });
});

// ── Suite 2: GuildSBT ──────────────────────────────────────────────────────
describe("GuildSBT", () => {
  it("creates a credit group", async () => {
    await guild.connect(groupMember1).createGroup("Kelompok Maju Jaya");
    assert.equal(await guild.memberToGroup(groupMember1.address), 1n);
  });

  it("allows members to join a group", async () => {
    await guild.connect(groupMember2).joinGroup(1n);
    assert.equal(await guild.isGroupMember(groupMember2.address), true);
  });

  it("starts at Bronze tier with score 500", async () => {
    const g = await guild.getGroup(1n);
    assert.equal(g.tier, 0n);
    assert.equal(g.collectiveScore, 500n);
  });

  it("upgrades to Silver at score ≥ 650", async () => {
    await guild.updateGroupScore(1n, 700n);
    assert.equal(await guild.getGroupTier(1n), 1n);
  });

  it("upgrades to Gold at score ≥ 800", async () => {
    await guild.updateGroupScore(1n, 850n);
    assert.equal(await guild.getGroupTier(1n), 2n);
  });

  it("reverts when member tries to join a second group", async () => {
    await assert.rejects(
      guild.connect(groupMember2).joinGroup(1n),
      /AlreadyInGroup/
    );
  });
});

// ── Suite 3: VouchRegistry ────────────────────────────────────────────────
describe("VouchRegistry", () => {
  it("allows vouching with ETH stake", async () => {
    await vouchRegistry.connect(groupMember1).vouch(borrower.address, 600n, {
      value: ethers.parseEther("0.01"),
    });
    assert.equal(await vouchRegistry.getActiveVouchCount(borrower.address), 1n);
  });

  it("computes stake-weighted vouch score", async () => {
    await vouchRegistry.connect(groupMember2).vouch(borrower.address, 400n, {
      value: ethers.parseEther("0.01"),
    });
    assert.equal(await vouchRegistry.getVouchScore(borrower.address), 500n);
  });

  it("reverts on self-vouch", async () => {
    await assert.rejects(
      vouchRegistry.connect(borrower).vouch(borrower.address, 500n, {
        value: ethers.parseEther("0.01"),
      }),
      /CannotVouchForSelf/
    );
  });

  it("reverts on insufficient stake", async () => {
    await assert.rejects(
      vouchRegistry.connect(lender1).vouch(borrower.address, 500n, {
        value: ethers.parseEther("0.0001"),
      }),
      /InsufficientStake/
    );
  });
});

// ── Suite 4: ReputationEngine ─────────────────────────────────────────────
describe("ReputationEngine", () => {
  it("recalculates composite score from 3 layers", async () => {
    const score = await repEngine.recalculateScore.staticCall(borrower.address);
    await repEngine.recalculateScore(borrower.address);
    assert.ok(score > 0n, `score ${score} should be > 0`);
  });

  it("integrates off-chain attestation score", async () => {
    await repEngine.connect(oracle).submitAttestationScore(borrower.address, 800n);
    const { attestScore } = await repEngine.getCompositeScore(borrower.address);
    assert.equal(attestScore, 800n);
  });

  it("rejects attestation from unauthorized oracle", async () => {
    await assert.rejects(
      repEngine.connect(lender1).submitAttestationScore(borrower.address, 800n),
      /NotAuthorizedOracle/
    );
  });

  it("reverts when weights do not sum to 100", async () => {
    await assert.rejects(repEngine.setWeights(50n, 30n, 30n), /WeightsMustSumTo100/);
  });
});

// ── Suite 5: InterestRateModel ────────────────────────────────────────────
describe("InterestRateModel – APR = Base + GroupRisk - RepDiscount", () => {
  it("charges higher APR to Bronze/low-reputation borrowers", async () => {
    // borrower has score 750, no group → Bronze premium applies
    const apr = await rateModel.calculateAPR(borrower.address);
    assert.ok(apr > 1500n, `APR ${apr} bps should be > 1500 bps`);
  });

  it("gives lower APR to Gold group members with high reputation", async () => {
    await guild.connect(borrower).createGroup("Kelompok Emas");
    const gId = await guild.memberToGroup(borrower.address);
    await guild.updateGroupScore(gId, 900n);
    await sbt.updateReputation(borrower.address, 950n);

    const apr = await rateModel.calculateAPR(borrower.address);
    assert.ok(apr <= 700n, `APR ${apr} bps should be ≤ 700 bps`);
  });

  it("calculates non-zero interest amount", async () => {
    const interest = await rateModel.calculateInterest(
      borrower.address,
      ethers.parseEther("1"),
      30n
    );
    assert.ok(interest > 0n);
  });
});

// ── Suite 6: LoanEscrow – Full Lifecycle ─────────────────────────────────
describe("LoanEscrow – Full Loan Lifecycle", () => {
  let loanId;

  it("rejects loan request without SBT", async () => {
    await assert.rejects(
      escrow.connect(lender2).requestLoan(ethers.parseEther("0.1"), 30n),
      /NoSBTFound/
    );
  });

  it("accepts loan request from SBT holder", async () => {
    const tx = await escrow.connect(borrower).requestLoan(ethers.parseEther("0.1"), 30n);
    await tx.wait();
    loanId = 1n;
    const loan = await escrow.getLoan(loanId);
    assert.equal(loan.status, 0n); // Requested
    assert.equal(loan.borrower, borrower.address);
  });

  it("activates loan after full funding and disburses ETH", async () => {
    const balBefore = await ethers.provider.getBalance(borrower.address);
    await escrow.connect(lender1).fundLoan(loanId, { value: ethers.parseEther("0.1") });
    const loan = await escrow.getLoan(loanId);
    assert.equal(loan.status, 2n); // Active
    const balAfter = await ethers.provider.getBalance(borrower.address);
    assert.ok(balAfter > balBefore);
  });

  it("rejects repayment from non-borrower", async () => {
    const loan = await escrow.getLoan(loanId);
    await assert.rejects(
      escrow.connect(lender1).repayLoan(loanId, { value: loan.totalDue }),
      /NotBorrower/
    );
  });

  it("accepts full repayment from borrower", async () => {
    const loan = await escrow.getLoan(loanId);
    await escrow.connect(borrower).repayLoan(loanId, { value: loan.totalDue });
    const repaid = await escrow.getLoan(loanId);
    assert.equal(repaid.status, 3n); // Repaid
  });

  it("lender withdraws principal plus interest after repayment", async () => {
    const balBefore = await ethers.provider.getBalance(lender1.address);
    await escrow.connect(lender1).withdrawLenderFunds(loanId, 0n);
    const balAfter = await ethers.provider.getBalance(lender1.address);
    assert.ok(balAfter > balBefore);
  });
});

// ── Suite 7: Default & Voucher Slash ─────────────────────────────────────
describe("Default Scenario – Voucher Slash & Reputation Penalty", () => {
  it("slashes vouchers and halves reputation on default", async () => {
    // Issue SBT to lender2 as the defaulting borrower
    await sbt.issueSBT(lender2.address);

    const tx = await escrow.connect(lender2).requestLoan(ethers.parseEther("0.05"), 7n);
    await tx.wait();
    const defaultLoanId = 2n;
    await escrow.connect(lender1).fundLoan(defaultLoanId, { value: ethers.parseEther("0.05") });

    await vouchRegistry.connect(groupMember1).vouch(lender2.address, 600n, {
      value: ethers.parseEther("0.02"),
    });
    assert.equal(await vouchRegistry.getActiveVouchCount(lender2.address), 1n);

    // Fast-forward past due date + 7-day grace period
    await connection.provider.send("evm_increaseTime", [15 * 24 * 60 * 60]);
    await connection.provider.send("evm_mine", []);

    const scoreBefore = await sbt.getReputationScore(lender2.address);
    await escrow.markDefault(defaultLoanId);

    const loan = await escrow.getLoan(defaultLoanId);
    assert.equal(loan.status, 4n); // Defaulted

    assert.equal(await vouchRegistry.getActiveVouchCount(lender2.address), 0n);

    const scoreAfter = await sbt.getReputationScore(lender2.address);
    assert.ok(scoreAfter <= scoreBefore / 2n + 1n, `Score ${scoreBefore} → ${scoreAfter}`);
  });
});
