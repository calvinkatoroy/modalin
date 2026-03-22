// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./SoulboundToken.sol";
import "./GuildSBT.sol";
import "./InterestRateModel.sol";
import "./VouchRegistry.sol";

/**
 * @title LoanEscrow
 * @notice Core lending contract for ModalIn. Handles:
 *   - Lenders funding a loan pool
 *   - Borrowers requesting and receiving loans
 *   - Repayments with algorithmically-computed interest
 *   - Default handling: slash vouchers, update reputation
 *
 * Loan lifecycle: Requested -> Funded -> Active -> Repaid | Defaulted
 */
contract LoanEscrow is Ownable, ReentrancyGuard {
    enum LoanStatus { Requested, Funded, Active, Repaid, Defaulted }

    struct Loan {
        uint256 loanId;
        address borrower;
        uint256 principal;
        uint256 interestAmount;
        uint256 totalDue;
        uint256 aprBasisPoints;
        uint256 durationDays;
        uint256 fundedAt;
        uint256 dueDate;
        uint256 amountRepaid;
        LoanStatus status;
    }

    struct LenderContribution {
        address lender;
        uint256 amount;
        uint256 loanId;
        bool withdrawn;
    }

    uint256 private _nextLoanId;
    mapping(uint256 => Loan) public loans;
    mapping(uint256 => LenderContribution[]) public loanContributions; // loanId => contributions
    mapping(address => uint256[]) public borrowerLoans;
    mapping(address => uint256[]) public lenderLoans;

    SoulboundToken public soulboundToken;
    GuildSBT public guildSBT;
    InterestRateModel public interestRateModel;
    VouchRegistry public vouchRegistry;

    uint256 public constant MIN_LOAN = 0.01 ether;
    uint256 public constant MAX_LOAN = 10 ether;
    uint256 public constant GRACE_PERIOD = 7 days;
    uint256 public platformFeeBps = 100; // 1% platform fee

    event LoanRequested(uint256 indexed loanId, address indexed borrower, uint256 principal);
    event LoanFunded(uint256 indexed loanId, address indexed lender, uint256 amount);
    event LoanDisbursed(uint256 indexed loanId, address indexed borrower, uint256 amount);
    event LoanRepaid(uint256 indexed loanId, address indexed borrower, uint256 totalRepaid);
    event LoanDefaulted(uint256 indexed loanId, address indexed borrower);
    event LenderWithdrew(uint256 indexed loanId, address indexed lender, uint256 amount);

    error LoanNotFound(uint256 loanId);
    error NotBorrower(uint256 loanId, address caller);
    error InvalidLoanStatus(uint256 loanId, LoanStatus expected, LoanStatus actual);
    error InsufficientRepayment(uint256 required, uint256 provided);
    error NoSBTFound(address borrower);
    error LoanAmountOutOfRange(uint256 amount);

    constructor(
        address _soulboundToken,
        address _guildSBT,
        address _interestRateModel,
        address _vouchRegistry
    ) Ownable(msg.sender) {
        soulboundToken = SoulboundToken(_soulboundToken);
        guildSBT = GuildSBT(_guildSBT);
        interestRateModel = InterestRateModel(_interestRateModel);
        vouchRegistry = VouchRegistry(_vouchRegistry);
        _nextLoanId = 1;
    }

    /**
     * @notice Borrower requests a loan. Must have an active SBT.
     */
    function requestLoan(uint256 principal, uint256 durationDays) external returns (uint256) {
        if (!soulboundToken.hasSBT(msg.sender)) revert NoSBTFound(msg.sender);
        if (principal < MIN_LOAN || principal > MAX_LOAN) revert LoanAmountOutOfRange(principal);
        require(durationDays >= 7 && durationDays <= 365, "Duration must be 7-365 days");

        uint256 apr = interestRateModel.calculateAPR(msg.sender);
        uint256 interest = interestRateModel.calculateInterest(msg.sender, principal, durationDays);
        uint256 totalDue = principal + interest;

        uint256 loanId = _nextLoanId++;
        loans[loanId] = Loan({
            loanId: loanId,
            borrower: msg.sender,
            principal: principal,
            interestAmount: interest,
            totalDue: totalDue,
            aprBasisPoints: apr,
            durationDays: durationDays,
            fundedAt: 0,
            dueDate: 0,
            amountRepaid: 0,
            status: LoanStatus.Requested
        });
        borrowerLoans[msg.sender].push(loanId);

        emit LoanRequested(loanId, msg.sender, principal);
        return loanId;
    }

    /**
     * @notice Lenders fund a loan by sending ETH. Loan activates when fully funded.
     */
    function fundLoan(uint256 loanId) external payable nonReentrant {
        Loan storage loan = loans[loanId];
        if (loan.loanId == 0) revert LoanNotFound(loanId);
        require(
            loan.status == LoanStatus.Requested || loan.status == LoanStatus.Funded,
            "Loan not open for funding"
        );
        require(msg.value > 0, "Must send ETH");

        uint256 alreadyFunded = _getTotalFunded(loanId);
        uint256 remaining = loan.principal - alreadyFunded;
        require(remaining > 0, "Loan already fully funded");

        uint256 contribution = msg.value > remaining ? remaining : msg.value;
        loanContributions[loanId].push(LenderContribution({
            lender: msg.sender,
            amount: contribution,
            loanId: loanId,
            withdrawn: false
        }));
        lenderLoans[msg.sender].push(loanId);
        loan.status = LoanStatus.Funded;

        // Refund excess
        if (msg.value > contribution) {
            (bool ok, ) = payable(msg.sender).call{value: msg.value - contribution}("");
            require(ok, "Refund failed");
        }

        emit LoanFunded(loanId, msg.sender, contribution);

        // If fully funded, disburse to borrower
        if (_getTotalFunded(loanId) >= loan.principal) {
            _disburse(loanId);
        }
    }

    /**
     * @notice Borrower repays the loan. Full repayment required.
     */
    function repayLoan(uint256 loanId) external payable nonReentrant {
        Loan storage loan = loans[loanId];
        if (loan.loanId == 0) revert LoanNotFound(loanId);
        if (loan.borrower != msg.sender) revert NotBorrower(loanId, msg.sender);
        if (loan.status != LoanStatus.Active) {
            revert InvalidLoanStatus(loanId, LoanStatus.Active, loan.status);
        }

        uint256 remaining = loan.totalDue - loan.amountRepaid;
        if (msg.value < remaining) revert InsufficientRepayment(remaining, msg.value);

        loan.amountRepaid += remaining;
        loan.status = LoanStatus.Repaid;

        // Refund overpayment
        if (msg.value > remaining) {
            (bool ok, ) = payable(msg.sender).call{value: msg.value - remaining}("");
            require(ok, "Overpayment refund failed");
        }

        // Update SBT records
        soulboundToken.recordRepayment(msg.sender, loan.principal);

        // Update group repayment record
        uint256 groupId = guildSBT.memberToGroup(msg.sender);
        if (groupId != 0) {
            guildSBT.recordGroupRepayment(groupId);
        }

        emit LoanRepaid(loanId, msg.sender, remaining);
    }

    /**
     * @notice Mark a loan as defaulted if past due date + grace period. Anyone can call.
     */
    function markDefault(uint256 loanId) external nonReentrant {
        Loan storage loan = loans[loanId];
        if (loan.loanId == 0) revert LoanNotFound(loanId);
        if (loan.status != LoanStatus.Active) {
            revert InvalidLoanStatus(loanId, LoanStatus.Active, loan.status);
        }
        require(block.timestamp > loan.dueDate + GRACE_PERIOD, "Grace period not elapsed");

        loan.status = LoanStatus.Defaulted;

        // Slash all vouchers
        vouchRegistry.slashVouchers(loan.borrower);

        // Penalize reputation: halve the score
        uint256 currentScore = soulboundToken.getReputationScore(loan.borrower);
        soulboundToken.updateReputation(loan.borrower, currentScore / 2);

        // Penalize group
        uint256 groupId = guildSBT.memberToGroup(loan.borrower);
        if (groupId != 0) {
            uint256 groupScore = guildSBT.getGroupScore(groupId);
            guildSBT.updateGroupScore(groupId, groupScore > 100 ? groupScore - 100 : 0);
        }

        emit LoanDefaulted(loanId, loan.borrower);
    }

    /**
     * @notice Lenders withdraw their principal + pro-rata interest after repayment.
     */
    function withdrawLenderFunds(uint256 loanId, uint256 contributionIndex) external nonReentrant {
        Loan storage loan = loans[loanId];
        require(loan.status == LoanStatus.Repaid || loan.status == LoanStatus.Defaulted, "Loan not settled");

        LenderContribution storage contrib = loanContributions[loanId][contributionIndex];
        require(contrib.lender == msg.sender, "Not your contribution");
        require(!contrib.withdrawn, "Already withdrawn");

        contrib.withdrawn = true;
        uint256 payout;

        if (loan.status == LoanStatus.Repaid) {
            uint256 platformFee = (loan.interestAmount * platformFeeBps) / 10000;
            uint256 distributableInterest = loan.interestAmount - platformFee;
            uint256 interestShare = (distributableInterest * contrib.amount) / loan.principal;
            payout = contrib.amount + interestShare;
        } else {
            // Default: return only what was recovered (partial)
            payout = (loan.amountRepaid * contrib.amount) / loan.principal;
        }

        (bool ok, ) = payable(msg.sender).call{value: payout}("");
        require(ok, "Withdrawal failed");

        emit LenderWithdrew(loanId, msg.sender, payout);
    }

    function _disburse(uint256 loanId) internal {
        Loan storage loan = loans[loanId];
        loan.status = LoanStatus.Active;
        loan.fundedAt = block.timestamp;
        loan.dueDate = block.timestamp + (loan.durationDays * 1 days);

        soulboundToken.recordLoan(loan.borrower, loan.principal);

        uint256 groupId = guildSBT.memberToGroup(loan.borrower);
        if (groupId != 0) {
            guildSBT.recordGroupLoan(groupId);
        }

        (bool ok, ) = payable(loan.borrower).call{value: loan.principal}("");
        require(ok, "Disbursement failed");

        emit LoanDisbursed(loanId, loan.borrower, loan.principal);
    }

    function _getTotalFunded(uint256 loanId) internal view returns (uint256 total) {
        LenderContribution[] storage contribs = loanContributions[loanId];
        for (uint256 i = 0; i < contribs.length; i++) {
            total += contribs[i].amount;
        }
    }

    function getLoan(uint256 loanId) external view returns (Loan memory) {
        return loans[loanId];
    }

    function getBorrowerLoans(address borrower) external view returns (uint256[] memory) {
        return borrowerLoans[borrower];
    }

    function getLoanContributions(uint256 loanId) external view returns (LenderContribution[] memory) {
        return loanContributions[loanId];
    }

    function setPlatformFee(uint256 feeBps) external onlyOwner {
        require(feeBps <= 500, "Fee cannot exceed 5%");
        platformFeeBps = feeBps;
    }

    receive() external payable {}
}
