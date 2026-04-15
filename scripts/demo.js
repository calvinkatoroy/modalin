/**
 * ModalIn – Interactive Demo Script
 *
 * Skenario: Budi (peminjam UMKM) meminjam 0.1 ETH dari Siti (lender),
 * didukung Kelompok Kredit dan social vouching. Plus skenario default.
 *
 * Run: npx hardhat run scripts/demo.js --network hardhat
 */

import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import hardhatEthersPlugin from "@nomicfoundation/hardhat-ethers";
import { createInterface } from "readline/promises";
import { stdin as input, stdout as output } from "process";

// ── ANSI helpers ─────────────────────────────────────────────────────────────
const C = {
  reset:   "\x1b[0m",
  bold:    "\x1b[1m",
  dim:     "\x1b[2m",
  green:   "\x1b[32m",
  yellow:  "\x1b[33m",
  cyan:    "\x1b[36m",
  red:     "\x1b[31m",
  blue:    "\x1b[34m",
  white:   "\x1b[37m",
};

const rl = createInterface({ input, output });

async function pause(label = "") {
  try {
    const msg = label || "Tekan Enter untuk lanjut...";
    await rl.question(`\n${C.dim}[ ${msg} ]${C.reset} `);
  } catch {
    // stdin closed (non-interactive / piped) – continue
  }
}

function banner(title) {
  const w = 60;
  const pad = " ".repeat(Math.max(0, Math.floor((w - 2 - title.length) / 2)));
  console.log(`\n${C.cyan}${"═".repeat(w)}`);
  console.log(`${pad}${C.bold}${title}${C.reset}`);
  console.log(`${C.cyan}${"═".repeat(w)}${C.reset}`);
}

function step(n, total, title) {
  console.log(`\n${C.yellow}┌─ Step ${n}/${total}: ${title} ${"─".repeat(Math.max(0, 44 - title.length))}┐${C.reset}`);
}

function ok(msg)   { console.log(`  ${C.green}✓${C.reset}  ${msg}`); }
function info(msg) { console.log(`  ${C.blue}ℹ${C.reset}  ${msg}`); }
function fail(msg) { console.log(`  ${C.red}✗${C.reset}  ${msg}`); }
function line()    { console.log(`  ${C.dim}${"─".repeat(50)}${C.reset}`); }

function fmtEth(wei, d = 4)  { return (Number(wei) / 1e18).toFixed(d) + " ETH"; }
function fmtBps(bps)          { return `${bps} bps (${(Number(bps) / 100).toFixed(2)}%)`; }
function tierName(t)          { return ["Bronze 🥉", "Silver 🥈", "Gold 🥇"][Number(t)] ?? "?"; }
function statusName(s)        { return ["Requested", "Funded", "Active", "Repaid", "Defaulted"][Number(s)] ?? "?"; }
function statusColor(s) {
  const n = Number(s);
  if (n === 3) return C.green;
  if (n === 4) return C.red;
  if (n === 2) return C.cyan;
  return C.yellow;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.clear();
  banner("ModalIn – P2P Micro-Lending Demo");

  console.log(`
  ${C.bold}ModalIn${C.reset} adalah platform pinjaman P2P terdesentralisasi
  untuk UMKM Indonesia. Demo ini akan mensimulasikan:

    ${C.cyan}1.${C.reset} Deploy 6 smart contracts
    ${C.cyan}2.${C.reset} Issue Soulbound Token (SBT) ke peminjam
    ${C.cyan}3.${C.reset} Bentuk Kelompok Kredit (Bronze → Gold)
    ${C.cyan}4.${C.reset} Social Vouching dengan ETH stake
    ${C.cyan}5.${C.reset} Kalkulasi APR dinamis berdasarkan reputasi
    ${C.cyan}6.${C.reset} Full loan lifecycle: request → fund → repay → withdraw
    ${C.cyan}7.${C.reset} Skenario default: slash vouch + penalti reputasi

  ${C.dim}Persona:
    Budi     = peminjam UMKM
    Siti     = lender
    Anggota1, Anggota2 = anggota kelompok kredit
    Joko     = peminjam yang gagal bayar${C.reset}
  `);

  await pause("Tekan Enter untuk mulai demo");

  // ── Init HRE ────────────────────────────────────────────────────────────
  const hre = await createHardhatRuntimeEnvironment(
    {
      plugins: [hardhatEthersPlugin],
      solidity: {
        version: "0.8.20",
        settings: { optimizer: { enabled: true, runs: 200 } },
      },
      networks: { hardhat: { type: "edr-simulated", chainId: 31337 } },
      paths: { sources: "./contracts", tests: "./test", cache: "./cache", artifacts: "./artifacts" },
    },
    {}
  );

  const connection = await hre.network.connect();
  const { ethers } = connection;
  const signers = await ethers.getSigners();
  const [owner, budi, siti, anggota1, anggota2, joko] = signers;

  // ── STEP 1: Deploy ───────────────────────────────────────────────────────
  step(1, 7, "Deploy 6 Smart Contracts");
  info("Deploying ke Hardhat in-memory network (chain 31337)...\n");

  const sbt = await (await ethers.getContractFactory("SoulboundToken")).deploy();
  await sbt.waitForDeployment();
  ok(`SoulboundToken    → ${await sbt.getAddress()}`);

  const guild = await (await ethers.getContractFactory("GuildSBT")).deploy();
  await guild.waitForDeployment();
  ok(`GuildSBT          → ${await guild.getAddress()}`);

  const vouchRegistry = await (await ethers.getContractFactory("VouchRegistry")).deploy();
  await vouchRegistry.waitForDeployment();
  ok(`VouchRegistry     → ${await vouchRegistry.getAddress()}`);

  const repEngine = await (await ethers.getContractFactory("ReputationEngine")).deploy(
    await sbt.getAddress(), await guild.getAddress(), await vouchRegistry.getAddress()
  );
  await repEngine.waitForDeployment();
  ok(`ReputationEngine  → ${await repEngine.getAddress()}`);

  const rateModel = await (await ethers.getContractFactory("InterestRateModel")).deploy(
    await sbt.getAddress(), await guild.getAddress()
  );
  await rateModel.waitForDeployment();
  ok(`InterestRateModel → ${await rateModel.getAddress()}`);

  const escrow = await (await ethers.getContractFactory("LoanEscrow")).deploy(
    await sbt.getAddress(), await guild.getAddress(),
    await rateModel.getAddress(), await vouchRegistry.getAddress()
  );
  await escrow.waitForDeployment();
  ok(`LoanEscrow        → ${await escrow.getAddress()}`);

  line();
  info("Wiring contract permissions...");
  await sbt.setAuthorizedUpdater(await repEngine.getAddress(), true);
  await sbt.setAuthorizedUpdater(await escrow.getAddress(), true);
  await sbt.setAuthorizedUpdater(owner.address, true);
  await guild.setAuthorizedUpdater(await repEngine.getAddress(), true);
  await guild.setAuthorizedUpdater(await escrow.getAddress(), true);
  await vouchRegistry.setLoanEscrow(await escrow.getAddress());
  ok("Semua permissions terhubung");

  await pause();

  // ── STEP 2: Issue SBT ────────────────────────────────────────────────────
  step(2, 7, "Issue Soulbound Token (SBT)");
  info(`Budi  : ${C.dim}${budi.address}${C.reset}`);
  info(`Saldo : ${fmtEth(await ethers.provider.getBalance(budi.address))}\n`);

  await sbt.issueSBT(budi.address);
  ok(`SBT diterbitkan → hasSBT: ${await sbt.hasSBT(budi.address)}`);
  ok(`Initial reputation score: ${C.bold}${await sbt.getReputationScore(budi.address)}${C.reset} / 1000`);

  line();
  info("Demonstrasi: SBT tidak bisa ditransfer (soulbound)...");
  try {
    await sbt.transfer(budi.address, 1n);
  } catch {
    fail(`Transfer ditolak → ${C.yellow}TransferNotAllowed${C.reset}`);
  }
  info("Demonstrasi: tidak bisa issue SBT kedua ke alamat yang sama...");
  try {
    await sbt.issueSBT(budi.address);
  } catch {
    fail(`Duplicate SBT ditolak → ${C.yellow}AlreadyHasSBT${C.reset}`);
  }

  await pause();

  // ── STEP 3: Kelompok Kredit ──────────────────────────────────────────────
  step(3, 7, "Buat Kelompok Kredit (GuildSBT)");
  info("Budi membentuk kelompok kredit \"Kelompok Maju Jaya\"...");

  await guild.connect(budi).createGroup("Kelompok Maju Jaya");
  const gId = await guild.memberToGroup(budi.address);
  ok(`Kelompok dibuat → ID: ${gId}`);

  await guild.connect(anggota1).joinGroup(gId);
  await guild.connect(anggota2).joinGroup(gId);
  ok("Anggota1 dan Anggota2 bergabung");

  let g = await guild.getGroup(gId);
  info(`Tier awal  : ${C.yellow}${tierName(g.tier)}${C.reset} (collective score: ${g.collectiveScore})`);
  line();

  info("Update score → 700 (Silver threshold ≥ 650)...");
  await guild.updateGroupScore(gId, 700n);
  ok(`Tier naik  : ${C.white}${tierName(await guild.getGroupTier(gId))}${C.reset}`);

  info("Update score → 850 (Gold threshold ≥ 800)...");
  await guild.updateGroupScore(gId, 850n);
  ok(`Tier naik  : ${C.yellow}${tierName(await guild.getGroupTier(gId))}${C.reset}`);

  info("Demonstrasi: tidak bisa masuk dua kelompok sekaligus...");
  try {
    await guild.connect(anggota2).joinGroup(gId);
  } catch {
    fail(`Double join ditolak → ${C.yellow}AlreadyInGroup${C.reset}`);
  }

  await pause();

  // ── STEP 4: Vouching ─────────────────────────────────────────────────────
  step(4, 7, "Social Vouching (VouchRegistry)");
  info("Anggota memberikan jaminan sosial (vouch) untuk Budi...\n");

  await vouchRegistry.connect(anggota1).vouch(budi.address, 600n, { value: ethers.parseEther("0.01") });
  ok(`Anggota1 → score: 600, stake: 0.01 ETH`);

  await vouchRegistry.connect(anggota2).vouch(budi.address, 400n, { value: ethers.parseEther("0.01") });
  ok(`Anggota2 → score: 400, stake: 0.01 ETH`);

  const vouchScore = await vouchRegistry.getVouchScore(budi.address);
  const vouchCount = await vouchRegistry.getActiveVouchCount(budi.address);
  ok(`Weighted vouch score: ${C.bold}${vouchScore}${C.reset} | Active vouches: ${vouchCount}`);
  info("Formula: stake-weighted average → (600×0.01 + 400×0.01) / (0.01+0.01) = 500");

  line();
  info("Demonstrasi: self-vouch dilarang...");
  try {
    await vouchRegistry.connect(budi).vouch(budi.address, 500n, { value: ethers.parseEther("0.01") });
  } catch {
    fail(`Self-vouch ditolak → ${C.yellow}CannotVouchForSelf${C.reset}`);
  }
  info("Demonstrasi: stake terlalu kecil...");
  try {
    await vouchRegistry.connect(siti).vouch(budi.address, 500n, { value: ethers.parseEther("0.0001") });
  } catch {
    fail(`Stake minimum tidak terpenuhi → ${C.yellow}InsufficientStake${C.reset}`);
  }

  await pause();

  // ── STEP 5: APR ──────────────────────────────────────────────────────────
  step(5, 7, "Kalkulasi APR Dinamis (InterestRateModel)");

  await sbt.updateReputation(budi.address, 900n);
  const repScore = await sbt.getReputationScore(budi.address);
  info(`Reputation score Budi  : ${C.bold}${repScore}${C.reset} / 1000`);
  info(`Tier kelompok Budi     : ${tierName(await guild.getGroupTier(gId))}`);

  const apr = await rateModel.calculateAPR(budi.address);
  const interest = await rateModel.calculateInterest(budi.address, ethers.parseEther("0.1"), 30n);

  line();
  ok(`APR       : ${C.green}${C.bold}${fmtBps(apr)}${C.reset}`);
  ok(`Bunga     : ${C.green}${fmtEth(interest, 6)}${C.reset} untuk 0.1 ETH selama 30 hari`);
  info("Formula APR: Base(1200) − RepDiscount − GroupBonus");

  await pause();

  // ── STEP 6: Full Loan Lifecycle ──────────────────────────────────────────
  step(6, 7, "Full Loan Lifecycle");

  // 6a. Request
  console.log(`\n  ${C.bold}6a. Request Loan${C.reset}`);
  info("Demonstrasi: pinjaman tanpa SBT ditolak...");
  try {
    await escrow.connect(siti).requestLoan(ethers.parseEther("0.1"), 30n);
  } catch {
    fail(`Pinjaman tanpa SBT ditolak → ${C.yellow}NoSBTFound${C.reset}`);
  }

  info("Budi mengajukan pinjaman 0.1 ETH selama 30 hari...");
  const reqTx = await escrow.connect(budi).requestLoan(ethers.parseEther("0.1"), 30n);
  await reqTx.wait();
  const loanId = 1n;
  let loan = await escrow.getLoan(loanId);

  ok(`Loan ID   : ${loanId}`);
  ok(`Status    : ${statusColor(loan.status)}${statusName(loan.status)}${C.reset}`);
  ok(`Principal : ${fmtEth(loan.principal)}`);
  ok(`APR       : ${fmtBps(loan.aprBasisPoints)}`);
  ok(`Total due : ${fmtEth(loan.totalDue, 6)} (termasuk bunga)`);

  await pause("Enter untuk lanjut ke funding...");

  // 6b. Fund
  console.log(`\n  ${C.bold}6b. Fund Loan${C.reset}`);
  const budiBefore = await ethers.provider.getBalance(budi.address);
  info(`Saldo Budi sebelum : ${fmtEth(budiBefore)}`);
  info("Siti mendanai pinjaman dengan 0.1 ETH...");

  await escrow.connect(siti).fundLoan(loanId, { value: ethers.parseEther("0.1") });
  loan = await escrow.getLoan(loanId);
  const budiAfter = await ethers.provider.getBalance(budi.address);

  ok(`Status              : ${statusColor(loan.status)}${statusName(loan.status)}${C.reset}`);
  ok(`Saldo Budi sesudah  : ${fmtEth(budiAfter)}`);
  ok(`ETH cair ke Budi    : ${C.green}+${fmtEth(budiAfter - budiBefore)}${C.reset}`);

  await pause("Enter untuk lanjut ke repayment...");

  // 6c. Repay
  console.log(`\n  ${C.bold}6c. Repay Loan${C.reset}`);
  loan = await escrow.getLoan(loanId);
  info(`Total yang harus dibayar : ${fmtEth(loan.totalDue, 6)}`);
  info(`  Principal : ${fmtEth(loan.principal)}`);
  info(`  Bunga     : ${fmtEth(loan.totalDue - loan.principal, 6)}`);

  info("Demonstrasi: non-borrower tidak bisa bayar...");
  try {
    await escrow.connect(siti).repayLoan(loanId, { value: loan.totalDue });
  } catch {
    fail(`Pembayaran dari non-borrower ditolak → ${C.yellow}NotBorrower${C.reset}`);
  }

  info("Budi melunasi pinjaman...");
  await escrow.connect(budi).repayLoan(loanId, { value: loan.totalDue });
  loan = await escrow.getLoan(loanId);
  const repScore2 = await sbt.getReputationScore(budi.address);
  const repayRate = await sbt.getRepaymentRate(budi.address);

  ok(`Status           : ${statusColor(loan.status)}${C.bold}${statusName(loan.status)}${C.reset}`);
  ok(`Reputasi Budi    : ${C.green}${repScore2}${C.reset} / 1000`);
  ok(`Repayment rate   : ${C.green}${repayRate}%${C.reset}`);

  await pause("Enter untuk lanjut ke withdrawal...");

  // 6d. Withdraw
  console.log(`\n  ${C.bold}6d. Lender Withdraw${C.reset}`);
  const sitiBefore = await ethers.provider.getBalance(siti.address);
  info(`Saldo Siti sebelum : ${fmtEth(sitiBefore)}`);

  await escrow.connect(siti).withdrawLenderFunds(loanId, 0n);
  const sitiAfter = await ethers.provider.getBalance(siti.address);

  ok(`Saldo Siti sesudah : ${fmtEth(sitiAfter)}`);
  ok(`Net gain Siti      : ${C.green}+${fmtEth(sitiAfter - sitiBefore)}${C.reset} (bunga dikurangi gas)`);

  await pause();

  // ── STEP 7: Default Scenario ─────────────────────────────────────────────
  step(7, 7, "Skenario Default & Voucher Slash");
  info(`Joko  : ${C.dim}${joko.address}${C.reset}`);
  info("Joko gagal bayar — vouch ter-slash, reputasi dipotong 50%\n");

  await sbt.issueSBT(joko.address);
  ok(`SBT diterbitkan untuk Joko (score: ${await sbt.getReputationScore(joko.address)})`);

  await vouchRegistry.connect(anggota1).vouch(joko.address, 600n, { value: ethers.parseEther("0.02") });
  ok(`Anggota1 vouch untuk Joko dengan stake 0.02 ETH`);
  ok(`Active vouches: ${await vouchRegistry.getActiveVouchCount(joko.address)}`);

  const dTx = await escrow.connect(joko).requestLoan(ethers.parseEther("0.05"), 7n);
  await dTx.wait();
  const defaultLoanId = 2n;
  await escrow.connect(siti).fundLoan(defaultLoanId, { value: ethers.parseEther("0.05") });
  ok(`Pinjaman ID ${defaultLoanId} aktif (0.05 ETH, 7 hari)`);

  line();
  info("Fast-forward waktu 15 hari (melewati due date + 7 hari grace period)...");
  await connection.provider.send("evm_increaseTime", [15 * 24 * 60 * 60]);
  await connection.provider.send("evm_mine", []);

  const scoreBefore = await sbt.getReputationScore(joko.address);
  await escrow.markDefault(defaultLoanId);

  const defaultLoan = await escrow.getLoan(defaultLoanId);
  const vouchAfter  = await vouchRegistry.getActiveVouchCount(joko.address);
  const scoreAfter  = await sbt.getReputationScore(joko.address);

  ok(`Status pinjaman   : ${C.red}${C.bold}${statusName(defaultLoan.status)}${C.reset}`);
  fail(`Vouch aktif       : 1 → ${vouchAfter} (semua ter-slash)`);
  fail(`Reputasi Joko     : ${scoreBefore} → ${C.red}${C.bold}${scoreAfter}${C.reset} (dipotong 50%)`);

  await pause("Enter untuk lihat ringkasan...");

  // ── Summary ──────────────────────────────────────────────────────────────
  banner("Demo Selesai – Ringkasan");

  console.log(`
  ${C.bold}Yang telah didemonstrasikan:${C.reset}

  ${C.green}✓${C.reset}  6 smart contracts deployed & wired on-chain
  ${C.green}✓${C.reset}  Soulbound Token: non-transferable, satu per alamat
  ${C.green}✓${C.reset}  Kelompok Kredit: Bronze → Silver → Gold tier
  ${C.green}✓${C.reset}  Social vouching dengan stake-weighted score
  ${C.green}✓${C.reset}  Dynamic APR berdasarkan reputasi + tier kelompok
  ${C.green}✓${C.reset}  Full loan lifecycle: request → fund → repay → withdraw
  ${C.green}✓${C.reset}  Default: vouch ter-slash, reputasi kena penalti 50%

  ${C.bold}Constraint yang terproteksi:${C.reset}
  ${C.red}✗${C.reset}  Transfer SBT → TransferNotAllowed
  ${C.red}✗${C.reset}  Duplicate SBT → AlreadyHasSBT
  ${C.red}✗${C.reset}  Pinjaman tanpa SBT → NoSBTFound
  ${C.red}✗${C.reset}  Self-vouch → CannotVouchForSelf
  ${C.red}✗${C.reset}  Bayar dari non-borrower → NotBorrower
  ${C.red}✗${C.reset}  Masuk dua kelompok → AlreadyInGroup

  ${C.dim}Untuk jalankan full test suite (38 assertions):
  npx hardhat run scripts/runTests.js --network hardhat${C.reset}
  `);

  rl.close();
}

main().catch((e) => {
  console.error(`\n${C.red}Error:${C.reset}`, e.message ?? e);
  rl.close();
  process.exit(1);
});
