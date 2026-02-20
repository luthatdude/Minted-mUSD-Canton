---
name: audit
description: "Comprehensive code and infrastructure auditing skill. Use when: (1) Scanning code for security vulnerabilities or exploits, (2) Running or enforcing test-driven development workflows, (3) Detecting code smells and suggesting refactors, (4) Reviewing architecture for scalability and security (Kubernetes, cloud-native, DevOps), (5) Conducting multi-file audits that require session persistence. Triggers on keywords: audit, vulnerability, security review, pentest, code smell, refactor, TDD, test coverage, architecture review, infrastructure review, codebase scan."
---

# Comprehensive Audit Skill

This skill provides five integrated audit capabilities. Select the appropriate mode based on the task, or combine modes for a full-spectrum audit.

---

## Mode 1: Security Auditing (Trail of Bits / CodeQL Style)

### When to Use
- Security review of smart contracts, APIs, backend services
- Pre-deployment vulnerability scanning
- Preparing for third-party audits (e.g., CertiK, Trail of Bits)
- Reviewing PRs for security regressions

### Procedure

1. **Inventory**: List all files in scope. Identify languages (Solidity, Python, JavaScript, TypeScript, Rust, DAML, C++).
2. **Dependency Scan**: Check `package.json`, `requirements.txt`, `Cargo.toml`, or equivalent for known vulnerable dependencies.
3. **Static Analysis Pass**: For each file, check against the vulnerability checklist below.
4. **Report**: Output findings in a structured format with severity ratings.

### Vulnerability Checklist

**Smart Contracts (Solidity/DAML)**
- Reentrancy attacks (external calls before state updates)
- Integer overflow/underflow (pre-Solidity 0.8)
- Unchecked return values on `.call()`, `.send()`, `.transfer()`
- Access control: missing `onlyOwner`, `require` guards
- Front-running susceptibility
- Flash loan attack vectors
- Improper use of `delegatecall`
- Uninitialized storage pointers
- tx.origin vs msg.sender confusion
- Oracle manipulation risks

**Backend (Python/JavaScript/TypeScript)**
- SQL/NoSQL injection (parameterized queries?)
- XSS (output encoding?)
- SSRF (URL validation?)
- Path traversal (input sanitization?)
- Insecure deserialization
- Hardcoded secrets, API keys, private keys in source
- Missing rate limiting on sensitive endpoints
- Broken authentication/session management
- CORS misconfiguration
- Missing input validation on all external inputs

**Infrastructure**
- Exposed ports, debug endpoints
- Default credentials
- Missing TLS/HTTPS enforcement
- Overly permissive IAM roles or file permissions
- Secrets in environment variables without vault

### Severity Rating

| Level | Definition | Example |
|-------|-----------|---------|
| CRITICAL | Exploitable now, funds/data at risk | Reentrancy in withdraw function |
| HIGH | Exploitable with moderate effort | Missing access control on admin function |
| MEDIUM | Potential risk, requires specific conditions | Front-running on non-critical operation |
| LOW | Best practice violation, minimal risk | Missing event emission |
| INFO | Suggestion for improvement | Code clarity, gas optimization |

### Output Format

```markdown
## Finding [ID]: [Title]
- **Severity**: CRITICAL / HIGH / MEDIUM / LOW / INFO
- **File**: `path/to/file.sol`
- **Lines**: 42-58
- **Description**: What the vulnerability is
- **Impact**: What an attacker could do
- **Proof of Concept**: Steps to exploit (if applicable)
- **Recommendation**: How to remediate
- **References**: CWE/SWC IDs, relevant documentation
```

---

## Mode 2: Automated TDD & Validation (Iron Law)

### When to Use
- Writing new features or resolving bugs
- Any code modification request during an audit
- Validating that remediations for audit findings actually work

### The Iron Law

**NEVER write implementation code without a failing test first.**

### Procedure

1. **Understand the requirement**: What should the code do? What are the edge cases?
2. **Write the test FIRST**:
   - Test the happy path
   - Test edge cases (empty input, max values, zero, null)
   - Test error conditions (invalid input, unauthorized access)
   - Test boundary conditions
3. **Run the test**: Confirm it FAILS (red phase)
4. **Write minimal implementation**: Only enough code to pass the test
5. **Run the test again**: Confirm it PASSES (green phase)
6. **Refactor**: Clean up while keeping tests green
7. **Repeat**: Next requirement

### Test Templates

**JavaScript/TypeScript (Jest)**
```javascript
describe('[FunctionName]', () => {
  it('should [expected behavior] when [condition]', () => {
    // Arrange
    const input = {};
    // Act
    const result = functionName(input);
    // Assert
    expect(result).toEqual(expectedOutput);
  });

  it('should throw when [error condition]', () => {
    expect(() => functionName(badInput)).toThrow('[ErrorMessage]');
  });
});
```

**Solidity (Foundry)**
```solidity
function test_ShouldRevertWhenUnauthorized() public {
    vm.prank(unauthorizedUser);
    vm.expectRevert("Unauthorized");
    contract.sensitiveFunction();
}

function test_ShouldUpdateStateCorrectly() public {
    // Arrange
    uint256 initialBalance = contract.balanceOf(user);
    // Act
    contract.deposit{value: 1 ether}();
    // Assert
    assertEq(contract.balanceOf(user), initialBalance + 1 ether);
}
```

**Python (pytest)**
```python
def test_should_return_expected_when_valid_input():
    # Arrange
    input_data = {"key": "value"}
    # Act
    result = function_under_test(input_data)
    # Assert
    assert result == expected_output

def test_should_raise_when_invalid_input():
    with pytest.raises(ValueError, match="Invalid input"):
        function_under_test(None)
```

### Validation Checklist Before Marking Any Remediation Complete
- [ ] All new tests pass
- [ ] All existing tests still pass (no regressions)
- [ ] Edge cases are covered
- [ ] Test names clearly describe what they verify

---

## Mode 3: Code Smell Detection & Refactoring

### When to Use
- Codebase health assessment
- Pre-refactor planning
- Reviewing code for maintainability issues
- When code "works but feels wrong"

### Smell Categories

**Bloaters** (code that has grown too large)
- Long Method: >30 lines, does multiple things
- Large Class/Module: >300 lines, too many responsibilities
- Long Parameter List: >4 parameters
- Primitive Obsession: using primitives instead of small objects
- Data Clumps: same group of variables passed around together

**Object-Orientation Abusers**
- Switch/if-else chains that should be polymorphism
- Refused Bequest: subclass ignores parent methods
- Temporary Field: object fields only used in certain situations

**Change Preventers** (code that's hard to modify)
- Divergent Change: one class modified for many different reasons
- Shotgun Surgery: one change requires edits across many files
- Parallel Inheritance: adding a subclass requires adding another elsewhere

**Dispensables** (unnecessary code)
- Dead Code: unreachable or unused functions/variables
- Duplicate Code: same logic in multiple places
- Speculative Generality: abstractions for cases that don't exist yet
- Comments explaining bad code (instead of fixing the code)

**Couplers** (excessive coupling)
- Feature Envy: method uses another class's data more than its own
- Inappropriate Intimacy: classes that know too much about each other
- Message Chains: `a.getB().getC().getD().doSomething()`

### Refactoring Recipes

| Smell | Refactoring | Description |
|-------|------------|-------------|
| Long Method | Extract Method/Function | Pull logical chunks into named functions |
| Large Class | Extract Class / PORO | Split into focused, single-responsibility objects |
| Long Parameter List | Parameter Object | Group related params into a struct/object |
| Duplicate Code | Extract & Share | Create shared utility or base class |
| Switch Chains | Strategy Pattern | Replace conditionals with polymorphism |
| Shotgun Surgery | Move Method/Field | Colocate related logic |
| Feature Envy | Move Method | Move logic to the class that owns the data |
| Dead Code | Delete It | Remove with confidence (tests will catch issues) |

### Output Format

```markdown
## Smell: [Category] - [Specific Smell]
- **File**: `path/to/file`
- **Lines**: 100-180
- **Severity**: High / Medium / Low
- **Description**: What the smell is and why it matters
- **Suggested Refactoring**: Specific steps to remediate
- **Effort Estimate**: Small (< 1hr) / Medium (1-4hr) / Large (4hr+)
```

---

## Mode 4: Context-Aware Architectural Review

### When to Use
- Evaluating system design for scalability
- Reviewing infrastructure configurations (Kubernetes, Docker, CI/CD)
- Assessing cloud-native architecture decisions
- Pre-launch architecture validation

### Infrastructure Security Checklist

**Kubernetes / Container Security**
- [ ] Containers run as non-root user
- [ ] Read-only root filesystem where possible
- [ ] Resource limits (CPU/memory) set on all pods
- [ ] Network policies restrict pod-to-pod communication
- [ ] Secrets managed via external secrets operator (not plain K8s secrets)
- [ ] Image scanning in CI pipeline
- [ ] Pod security standards enforced (restricted/baseline)
- [ ] No privileged containers
- [ ] Ingress TLS termination configured
- [ ] RBAC follows least-privilege principle

**Cloud-Native Architecture**
- [ ] Stateless services (state in external stores)
- [ ] Health checks (liveness, readiness, startup probes)
- [ ] Graceful shutdown handling
- [ ] Circuit breakers on external dependencies
- [ ] Horizontal pod autoscaling configured
- [ ] Database connection pooling
- [ ] Centralized logging and monitoring
- [ ] Distributed tracing enabled
- [ ] Backup and disaster recovery tested

**DevOps / CI/CD**
- [ ] Branch protection rules enforced
- [ ] Automated testing in pipeline (unit, integration, e2e)
- [ ] Secrets not hardcoded in pipeline configs
- [ ] Infrastructure as Code (Terraform, Pulumi) version controlled
- [ ] Rollback strategy defined and tested
- [ ] Environment parity (dev ≈ staging ≈ prod)
- [ ] Dependency update automation (Dependabot, Renovate)

**DeFi / Blockchain Specific**
- [ ] Bridge security: multi-sig or threshold signatures
- [ ] Oracle redundancy: multiple price feeds, TWAP
- [ ] Upgrade mechanism: timelock on proxy upgrades
- [ ] Emergency pause functionality
- [ ] TVL monitoring and circuit breakers
- [ ] MEV protection considered
- [ ] Cross-chain message verification

### Output Format

```markdown
## Architecture Finding: [Title]
- **Category**: Security / Scalability / Reliability / Operability
- **Severity**: CRITICAL / HIGH / MEDIUM / LOW
- **Component**: [service/infrastructure affected]
- **Current State**: What exists now
- **Risk**: What could go wrong
- **Recommendation**: What to change
- **Trade-offs**: Cost, complexity, migration effort
```

---

## Mode 5: Session-Based Auditing (Persistent Context)

### When to Use
- Multi-file audits spanning large codebases
- Audits that take multiple sessions to complete
- When you need to track findings across many files without losing context

### Procedure

#### Starting a Session

1. **Check for existing sessions**:
   ```
   Look for: docs/plans/audit-session-*.md
   ```
2. **If session exists**: Read it. Resume from where you left off. Do NOT re-audit files already marked complete.
3. **If no session exists**: Create one using the template below.

#### Session File Template

Create at `docs/plans/audit-session-[YYYY-MM-DD].md`:

```markdown
# Audit Session: [Project Name]
- **Started**: [date]
- **Last Updated**: [date]
- **Auditor**: AI-Assisted
- **Scope**: [what is being audited]
- **Mode(s)**: [which audit modes are active]

## Progress

### Files Audited
| File | Status | Findings | Notes |
|------|--------|----------|-------|
| `src/contracts/Token.sol` | ✅ Complete | 2 HIGH, 1 MEDIUM | Needs reentrancy guard |
| `src/bridge/Bridge.sol` | 🔄 In Progress | 1 CRITICAL (partial) | Stopped at line 200 |
| `src/utils/oracle.ts` | ⬜ Pending | - | - |

### Cumulative Findings Summary
- CRITICAL: 0
- HIGH: 2
- MEDIUM: 1
- LOW: 0
- INFO: 0

### Detailed Findings
[Append findings here as they are discovered, using the format from the relevant mode]

### Notes & Context
[Important architectural decisions, cross-file dependencies, or context needed for future sessions]
```

#### During the Audit

- After completing each file, update the session file immediately
- Record cross-file dependencies as you discover them
- Note any assumptions that affect multiple findings

#### Ending a Session

- Update the "Last Updated" timestamp
- Mark current file as "In Progress" with line number if incomplete
- Summarize what to do next under "Notes & Context"

---

## Running a Full Audit

When asked for a comprehensive audit, run modes in this order:

1. **Session Setup** (Mode 5): Initialize or resume session
2. **Security Scan** (Mode 1): Find vulnerabilities first (highest priority)
3. **Architecture Review** (Mode 4): Assess structural issues
4. **Code Smell Detection** (Mode 3): Identify maintainability issues
5. **Write Regression Tests** (Mode 2): For any remediations, follow the Iron Law
6. **Update Session** (Mode 5): Persist progress

Always prioritize CRITICAL and HIGH findings. Present a summary table at the end of each session.
