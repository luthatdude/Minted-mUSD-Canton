/**
 * Minted Protocol — Referral System
 *
 * Invite-tree with configurable kickback (default 10%).
 * Each user gets a unique referral code on first deposit.
 * Referrer earns kickbackPct of referee's points (minted fresh, not deducted).
 *
 * Data model (SQLite):
 *   referrals(code TEXT PK, owner TEXT, created_at INTEGER)
 *   referral_links(referee TEXT PK, referrer TEXT, code TEXT, linked_at INTEGER)
 *
 * Viral coefficient target: 1.3 (each user brings 1.3 new users).
 */

import crypto from "crypto";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface ReferralConfig {
  /** Percentage of referee's points minted to referrer (default 10%) */
  kickbackPct: number;
  /** Max referral depth for multi-level (1 = direct only, 2 = referrer + grandparent) */
  maxDepth: number;
  /** Kickback decay per depth level (e.g., 0.5 means grandparent gets 5% if base is 10%) */
  depthDecay: number;
  /** Max codes per user */
  maxCodesPerUser: number;
  /** Max referees per code (0 = unlimited) */
  maxRefereesPerCode: number;
}

export interface ReferralCode {
  code: string;
  owner: string;
  createdAt: number;
  usageCount: number;
}

export interface ReferralLink {
  referee: string;
  referrer: string;
  code: string;
  linkedAt: number;
}

export interface ReferralStats {
  address: string;
  codes: ReferralCode[];
  totalReferees: number;
  totalKickbackPoints: number;
  referralChain: { depth: number; address: string }[];
}

export interface KickbackEntry {
  referrer: string;
  referee: string;
  depth: number;
  kickbackPct: number;
  pointsAwarded: number;
}

// ═══════════════════════════════════════════════════════════════
// Default Config
// ═══════════════════════════════════════════════════════════════

export const DEFAULT_REFERRAL_CONFIG: ReferralConfig = {
  kickbackPct: 10,         // 10% of referee's earned points
  maxDepth: 2,             // Direct + one level up
  depthDecay: 0.5,         // Grandparent gets 5% (10% × 0.5)
  maxCodesPerUser: 5,      // 5 invite codes per user
  maxRefereesPerCode: 0,   // Unlimited uses per code
};

// ═══════════════════════════════════════════════════════════════
// Code Generation
// ═══════════════════════════════════════════════════════════════

/**
 * Generate a unique, URL-safe referral code.
 * Format: MNTD-XXXXXX (6 chars, uppercase alphanumeric)
 */
export function generateReferralCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // No 0/O/1/I for readability
  const bytes = crypto.randomBytes(6);
  let code = "MNTD-";
  for (let i = 0; i < 6; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return code;
}

// ═══════════════════════════════════════════════════════════════
// Referral Service
// ═══════════════════════════════════════════════════════════════

export class ReferralService {
  /** code -> ReferralCode */
  private codes: Map<string, ReferralCode> = new Map();
  /** owner address -> codes[] */
  private ownerCodes: Map<string, string[]> = new Map();
  /** referee address -> ReferralLink */
  private links: Map<string, ReferralLink> = new Map();
  /** referrer address -> total kickback points earned */
  private kickbackTotals: Map<string, number> = new Map();
  private config: ReferralConfig;

  constructor(config: ReferralConfig = DEFAULT_REFERRAL_CONFIG) {
    this.config = config;
  }

  // ─── Code Management ────────────────────────────────────────

  /**
   * Create a new referral code for a user.
   * Returns the code string or throws if limit reached.
   */
  createCode(owner: string): string {
    const addr = owner.toLowerCase();
    const existing = this.ownerCodes.get(addr) || [];

    if (existing.length >= this.config.maxCodesPerUser) {
      throw new Error(
        `MAX_CODES_REACHED: ${addr} already has ${existing.length}/${this.config.maxCodesPerUser} codes`
      );
    }

    let code: string;
    let attempts = 0;
    do {
      code = generateReferralCode();
      attempts++;
      if (attempts > 100) throw new Error("CODE_GENERATION_FAILED");
    } while (this.codes.has(code));

    const referralCode: ReferralCode = {
      code,
      owner: addr,
      createdAt: Date.now(),
      usageCount: 0,
    };

    this.codes.set(code, referralCode);
    existing.push(code);
    this.ownerCodes.set(addr, existing);

    return code;
  }

  /**
   * Get all codes owned by an address.
   */
  getCodesForOwner(owner: string): ReferralCode[] {
    const addr = owner.toLowerCase();
    const codeIds = this.ownerCodes.get(addr) || [];
    return codeIds.map((c) => this.codes.get(c)!).filter(Boolean);
  }

  // ─── Link Management ────────────────────────────────────────

  /**
   * Link a referee to a referrer via code.
   * Must be called before the referee earns any points.
   */
  linkReferral(referee: string, code: string): ReferralLink {
    const refAddr = referee.toLowerCase();

    // Validate code exists
    const referralCode = this.codes.get(code);
    if (!referralCode) {
      throw new Error(`INVALID_CODE: ${code}`);
    }

    // Can't refer yourself
    if (referralCode.owner === refAddr) {
      throw new Error("SELF_REFERRAL");
    }

    // Can't be referred twice
    if (this.links.has(refAddr)) {
      throw new Error(`ALREADY_REFERRED: ${refAddr}`);
    }

    // Check per-code usage cap
    if (
      this.config.maxRefereesPerCode > 0 &&
      referralCode.usageCount >= this.config.maxRefereesPerCode
    ) {
      throw new Error(`CODE_EXHAUSTED: ${code}`);
    }

    // Prevent circular referral chains
    if (this.wouldCreateCycle(refAddr, referralCode.owner)) {
      throw new Error("CIRCULAR_REFERRAL");
    }

    const link: ReferralLink = {
      referee: refAddr,
      referrer: referralCode.owner,
      code,
      linkedAt: Date.now(),
    };

    this.links.set(refAddr, link);
    referralCode.usageCount++;

    return link;
  }

  /**
   * Check if linking referee -> referrer would create a cycle.
   */
  private wouldCreateCycle(referee: string, referrer: string): boolean {
    let current = referrer;
    const visited = new Set<string>();
    while (current) {
      if (current === referee) return true;
      if (visited.has(current)) return false; // Already checked, no cycle to referee
      visited.add(current);
      const parentLink = this.links.get(current);
      if (!parentLink) return false;
      current = parentLink.referrer;
    }
    return false;
  }

  // ─── Kickback Calculation ───────────────────────────────────

  /**
   * Calculate kickback points for a referee's earned points.
   * Returns array of KickbackEntry — one per ancestor up to maxDepth.
   *
   * Example with 10% kickback, maxDepth=2, decay=0.5:
   *   Referee earns 1000 pts
   *   → Direct referrer gets 100 pts (10%)
   *   → Grandparent gets 50 pts (10% × 0.5 = 5%)
   */
  calculateKickbacks(referee: string, earnedPoints: number): KickbackEntry[] {
    const refAddr = referee.toLowerCase();
    const entries: KickbackEntry[] = [];

    let current = refAddr;
    let depth = 0;

    while (depth < this.config.maxDepth) {
      const link = this.links.get(current);
      if (!link) break;

      depth++;
      const decayFactor = Math.pow(this.config.depthDecay, depth - 1);
      const effectivePct = this.config.kickbackPct * decayFactor;
      const kickbackPoints = Math.floor((earnedPoints * effectivePct) / 100);

      if (kickbackPoints > 0) {
        entries.push({
          referrer: link.referrer,
          referee: refAddr,
          depth,
          kickbackPct: effectivePct,
          pointsAwarded: kickbackPoints,
        });

        // Track totals
        const existing = this.kickbackTotals.get(link.referrer) || 0;
        this.kickbackTotals.set(link.referrer, existing + kickbackPoints);
      }

      current = link.referrer;
    }

    return entries;
  }

  // ─── Stats & Queries ────────────────────────────────────────

  /**
   * Get full referral stats for a user.
   */
  getStats(address: string): ReferralStats {
    const addr = address.toLowerCase();
    const codes = this.getCodesForOwner(addr);

    // Count direct referees
    let totalReferees = 0;
    for (const [, link] of this.links) {
      if (link.referrer === addr) totalReferees++;
    }

    // Build referral chain (who referred me, and who referred them)
    const chain: { depth: number; address: string }[] = [];
    let current = addr;
    let depth = 0;
    while (depth < 10) {
      const link = this.links.get(current);
      if (!link) break;
      depth++;
      chain.push({ depth, address: link.referrer });
      current = link.referrer;
    }

    return {
      address: addr,
      codes,
      totalReferees,
      totalKickbackPoints: this.kickbackTotals.get(addr) || 0,
      referralChain: chain,
    };
  }

  /**
   * Get the referral tree for a user (who they referred, recursively).
   */
  getReferralTree(address: string, maxDepth = 3): {
    address: string;
    depth: number;
    referees: { address: string; linkedAt: number; points: number }[];
  } {
    const addr = address.toLowerCase();
    const referees: { address: string; linkedAt: number; points: number }[] = [];

    for (const [, link] of this.links) {
      if (link.referrer === addr) {
        referees.push({
          address: link.referee,
          linkedAt: link.linkedAt,
          points: this.kickbackTotals.get(link.referee) || 0,
        });
      }
    }

    return { address: addr, depth: 0, referees };
  }

  /**
   * Validate a referral code without linking.
   */
  validateCode(code: string): { valid: boolean; owner?: string; remaining?: number } {
    const referralCode = this.codes.get(code);
    if (!referralCode) return { valid: false };

    const remaining =
      this.config.maxRefereesPerCode > 0
        ? this.config.maxRefereesPerCode - referralCode.usageCount
        : -1; // -1 = unlimited

    return {
      valid: remaining !== 0,
      owner: referralCode.owner,
      remaining: remaining === -1 ? undefined : remaining,
    };
  }

  /**
   * Get global referral metrics.
   */
  getGlobalMetrics(): {
    totalCodes: number;
    totalLinks: number;
    totalKickbackPoints: number;
    avgRefereesPerReferrer: number;
    viralCoefficient: number;
  } {
    const referrerCounts = new Map<string, number>();
    let totalKickback = 0;

    for (const [, link] of this.links) {
      referrerCounts.set(
        link.referrer,
        (referrerCounts.get(link.referrer) || 0) + 1
      );
    }

    for (const [, pts] of this.kickbackTotals) {
      totalKickback += pts;
    }

    const referrerCount = referrerCounts.size;
    const totalLinks = this.links.size;
    const avgReferees = referrerCount > 0 ? totalLinks / referrerCount : 0;

    // Viral coefficient = avg referees per referrer × conversion rate
    // Simplified: just avg referees (assuming 100% conversion from code → deposit)
    const viralCoefficient = avgReferees;

    return {
      totalCodes: this.codes.size,
      totalLinks,
      totalKickbackPoints: totalKickback,
      avgRefereesPerReferrer: Math.round(avgReferees * 100) / 100,
      viralCoefficient: Math.round(viralCoefficient * 100) / 100,
    };
  }
}
