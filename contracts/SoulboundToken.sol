// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title SoulboundToken
 * @notice ERC-5114 inspired non-transferable credit reputation token for ModalIn UMKM borrowers.
 * Each address can hold exactly one SBT. Transfers are permanently disabled.
 */
contract SoulboundToken is Ownable, ReentrancyGuard {
    struct CreditProfile {
        uint256 tokenId;
        uint256 reputationScore;     // 0-1000 scale
        uint256 totalLoansBorrowed;
        uint256 totalLoansRepaid;
        uint256 totalAmountBorrowed;
        uint256 totalAmountRepaid;
        uint256 lastUpdated;
        bool isActive;
    }

    uint256 private _nextTokenId;
    mapping(address => CreditProfile) private _profiles;
    mapping(uint256 => address) private _tokenOwners;
    mapping(address => bool) public authorizedUpdaters; // ReputationEngine, LoanEscrow

    event SBTIssued(address indexed to, uint256 indexed tokenId);
    event ReputationUpdated(address indexed holder, uint256 oldScore, uint256 newScore);
    event UpdaterAuthorized(address indexed updater, bool authorized);

    error AlreadyHasSBT(address account);
    error NoSBT(address account);
    error TransferNotAllowed();
    error NotAuthorized();

    modifier onlyAuthorized() {
        if (!authorizedUpdaters[msg.sender] && msg.sender != owner()) revert NotAuthorized();
        _;
    }

    constructor() Ownable(msg.sender) {
        _nextTokenId = 1;
    }

    /**
     * @notice Issues a new SBT to a borrower. Each address can only have one.
     */
    function issueSBT(address to) external onlyAuthorized nonReentrant returns (uint256) {
        if (_profiles[to].isActive) revert AlreadyHasSBT(to);

        uint256 tokenId = _nextTokenId++;
        _profiles[to] = CreditProfile({
            tokenId: tokenId,
            reputationScore: 500, // start at neutral score
            totalLoansBorrowed: 0,
            totalLoansRepaid: 0,
            totalAmountBorrowed: 0,
            totalAmountRepaid: 0,
            lastUpdated: block.timestamp,
            isActive: true
        });
        _tokenOwners[tokenId] = to;

        emit SBTIssued(to, tokenId);
        return tokenId;
    }

    /**
     * @notice Updates reputation score for a borrower. Called by ReputationEngine.
     */
    function updateReputation(address holder, uint256 newScore) external onlyAuthorized {
        if (!_profiles[holder].isActive) revert NoSBT(holder);
        require(newScore <= 1000, "Score exceeds maximum");

        uint256 oldScore = _profiles[holder].reputationScore;
        _profiles[holder].reputationScore = newScore;
        _profiles[holder].lastUpdated = block.timestamp;

        emit ReputationUpdated(holder, oldScore, newScore);
    }

    /**
     * @notice Records a new loan for a borrower. Called by LoanEscrow.
     */
    function recordLoan(address borrower, uint256 amount) external onlyAuthorized {
        if (!_profiles[borrower].isActive) revert NoSBT(borrower);
        _profiles[borrower].totalLoansBorrowed++;
        _profiles[borrower].totalAmountBorrowed += amount;
        _profiles[borrower].lastUpdated = block.timestamp;
    }

    /**
     * @notice Records a loan repayment. Called by LoanEscrow.
     */
    function recordRepayment(address borrower, uint256 amount) external onlyAuthorized {
        if (!_profiles[borrower].isActive) revert NoSBT(borrower);
        _profiles[borrower].totalLoansRepaid++;
        _profiles[borrower].totalAmountRepaid += amount;
        _profiles[borrower].lastUpdated = block.timestamp;
    }

    function setAuthorizedUpdater(address updater, bool authorized) external onlyOwner {
        authorizedUpdaters[updater] = authorized;
        emit UpdaterAuthorized(updater, authorized);
    }

    function getProfile(address holder) external view returns (CreditProfile memory) {
        return _profiles[holder];
    }

    function hasSBT(address account) external view returns (bool) {
        return _profiles[account].isActive;
    }

    function getReputationScore(address holder) external view returns (uint256) {
        return _profiles[holder].reputationScore;
    }

    function getRepaymentRate(address holder) external view returns (uint256) {
        CreditProfile memory p = _profiles[holder];
        if (p.totalLoansBorrowed == 0) return 100; // no history = assume 100%
        return (p.totalLoansRepaid * 100) / p.totalLoansBorrowed;
    }

    // Soulbound: all transfer-like operations are permanently disabled
    function transfer(address, uint256) external pure {
        revert TransferNotAllowed();
    }
}
