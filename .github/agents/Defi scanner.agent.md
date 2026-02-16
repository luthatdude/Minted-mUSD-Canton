---
description: '#!/usr/bin/env python3
"""
Minted DeFi Research Agent — Deep Scanner
==========================================
Scans the full DeFi yield landscape via DefiLlama + on-chain data.
Covers lending, borrowing, LP, staking, restaking, looping, and RWA yields.

Setup:
  pip install anthropic requests rich tabulate

Usage:
  python defi_scanner.py                    # full interactive agent
  python defi_scanner.py scan               # full yield scan, print report
  python defi_scanner.py scan --top 50      # top 50 opportunities
  python defi_scanner.py lending            # lending/borrowing focus
  python defi_scanner.py lp                 # LP opportunities focus
  python defi_scanner.py looping            # looping strategy calculator
  python defi_scanner.py stables            # stablecoin yields only
  python defi_scanner.py report             # generate full PDF/markdown report
  python defi_scanner.py watch USDC         # monitor specific asset
  python defi_scanner.py compare aave morpho # compare protocols head to head
"""

import os
import sys
import json
import time
import argparse
from datetime import datetime, timedelta
from typing import Optional
from dataclasses import dataclass, field

import requests
from rich.console import Console
from rich.table import Table
from rich.panel import Panel
from rich.columns import Columns
from rich.markdown import Markdown
from rich.progress import Progress, SpinnerColumn, TextColumn
from rich import box

# ── CONFIG ──
DEFILLAMA_POOLS = "https://yields.llama.fi/pools"
DEFILLAMA_LEND_BORROW = "https://yields.llama.fi/lendBorrow"
DEFILLAMA_PROTOCOLS = "https://api.llama.fi/protocols"
DEFILLAMA_STABLECOINS = "https://stablecoins.llama.fi/stablecoins?includePrices=true"

ANTHROPIC_MODEL = "claude-sonnet-4-20250514"

# Stablecoin symbols for filtering
STABLECOINS = {
    "USDC", "USDT", "DAI", "FRAX", "LUSD", "TUSD", "BUSD", "GUSD", "USDP",
    "USDD", "CRVUSD", "GHO", "PYUSD", "MKUSD", "USDE", "SUSDE", "SDAI",
    "SUSDS", "USDY", "USDM", "BUIDL", "MUSD", "DOLA", "ALUSD", "EUSD",
    "USDA", "USD0", "FDUSD", "USDB", "ULTRAUSD", "BOLD", "CASH",
}

# Blue chip protocols for risk scoring
BLUE_CHIP = {
    "aave-v3", "aave-v2", "compound-v3", "compound-v2", "maker", "morpho",
    "morpho-blue", "lido", "rocket-pool", "curve-dex", "uniswap-v3",
    "convex-finance", "yearn-finance", "pendle", "fluid", "spark",
    "sky", "ethena", "eigenlayer", "ondo-finance",
}

ESTABLISHED = {
    "aerodrome", "velodrome", "camelot", "gmx", "radiant-v2",
    "silo-v2", "euler", "benqi", "venus", "moonwell",
    "seamless-protocol", "extra-finance", "contango",
    "sturdy", "sommelier", "instadapp", "gearbox",
}

# Chain name normalization
CHAIN_SHORT = {
    "Ethereum": "ETH",
    "Arbitrum": "ARB",
    "Optimism": "OP",
    "Base": "BASE",
    "Polygon": "POLY",
    "BSC": "BSC",
    "Avalanche": "AVAX",
    "Solana": "SOL",
    "Fantom": "FTM",
    "Gnosis": "GNO",
    "Scroll": "SCROLL",
    "Blast": "BLAST",
    "Linea": "LINEA",
    "Mode": "MODE",
    "Mantle": "MANTLE",
    "zkSync Era": "ZK",
    "Polygon zkEVM": "PZK",
    "Manta": "MANTA",
}

console = Console()


# ═══════════════════════════════════════════
# DATA LAYER
# ═══════════════════════════════════════════

@dataclass
class YieldPool:
    pool_id: str
    project: str
    chain: str
    symbol: str
    tvl: float
    apy: float
    apy_base: float          # base APY (fees/interest)
    apy_reward: float         # reward APY (token emissions)
    apy_mean_30d: float       # 30d average
    il_risk: bool             # impermanent loss risk
    stablecoin: bool
    exposure: str             # "single", "multi"
    pool_category: str        # lending, dex, yield, staking, etc.
    borrow_rate: Optional[float] = None
    ltv: Optional[float] = None
    total_supply_usd: Optional[float] = None
    total_borrow_usd: Optional[float] = None
    utilization: Optional[float] = None
    apy_7d: Optional[float] = None
    volume_usd_1d: Optional[float] = None
    risk_score: int = 0       # 1-10, lower is safer

    @property
    def chain_short(self):
        return CHAIN_SHORT.get(self.chain, self.chain[:5].upper())

    @property
    def risk_label(self):
        if self.risk_score <= 2: return "🟢 LOW"
        if self.risk_score <= 4: return "🟡 MED"
        if self.risk_score <= 6: return "🟠 HIGH"
        return "🔴 DEGEN"

    @property
    def is_sustainable(self):
        """Check if yield is mostly from base (organic) vs rewards (emissions)."""
        if self.apy <= 0:
            return True
        return self.apy_base / max(self.apy, 0.01) > 0.5


@dataclass
class LoopingStrategy:
    pool: YieldPool
    loops: int
    net_apy: float
    leverage: float
    liquidation_buffer: float
    supply_apy: float
    borrow_apy: float
    ltv: float


class DefiScanner:
    """Core scanner that pulls and analyzes DeFi yield data."""

    def __init__(self):
        self.pools: list[YieldPool] = []
        self.lend_borrow_data: dict = {}
        self.last_fetch: Optional[datetime] = None
        self.cache_duration = timedelta(minutes=5)

    def fetch_all(self, force=False):
        """Fetch all yield data from DefiLlama."""
        if not force and self.last_fetch and datetime.now() - self.last_fetch < self.cache_duration:
            return

        with Progress(
            SpinnerColumn(style="green"),
            TextColumn("[dim]{task.description}"),
            console=console,
        ) as progress:
            # Fetch pools
            task = progress.add_task("Fetching yield pools...", total=None)
            try:
                resp = requests.get(DEFILLAMA_POOLS, timeout=30)
                resp.raise_for_status()
                raw_pools = resp.json().get("data", [])
                progress.update(task, description=f"Fetched {len(raw_pools)} pools")
            except Exception as e:
                console.print(f"[red]Error fetching pools: {e}[/red]")
                return

            # Fetch lend/borrow data
            progress.update(task, description="Fetching lending/borrowing rates...")
            try:
                resp2 = requests.get(DEFILLAMA_LEND_BORROW, timeout=30)
                resp2.raise_for_status()
                lb_data = resp2.json()
                for item in lb_data:
                    self.lend_borrow_data[item.get("pool", "")] = item
            except Exception as e:
                console.print(f"[yellow]Warning: Could not fetch lend/borrow data: {e}[/yellow]")

            # Parse pools
            progress.update(task, description="Processing pools...")
            self.pools = []
            for p in raw_pools:
                tvl = p.get("tvlUsd", 0) or 0
                if tvl < 10_000:  # skip dust pools
                    continue

                apy = p.get("apy", 0) or 0
                apy_base = p.get("apyBase", 0) or 0
                apy_reward = p.get("apyReward", 0) or 0
                apy_mean = p.get("apyMean30d", 0) or 0

                symbol = p.get("symbol", "???")
                project = p.get("project", "unknown")

                # Get lend/borrow info if available
                pool_id = p.get("pool", "")
                lb = self.lend_borrow_data.get(pool_id, {})

                pool = YieldPool(
                    pool_id=pool_id,
                    project=project,
                    chain=p.get("chain", "Unknown"),
                    symbol=symbol,
                    tvl=tvl,
                    apy=apy,
                    apy_base=apy_base,
                    apy_reward=apy_reward,
                    apy_mean_30d=apy_mean,
                    il_risk=p.get("ilRisk", "no") == "yes",
                    stablecoin=p.get("stablecoin", False),
                    exposure=p.get("exposure", "single"),
                    pool_category=p.get("category", "").lower() if p.get("category") else self._infer_category(project),
                    borrow_rate=lb.get("apyBaseBorrow"),
                    ltv=lb.get("ltv"),
                    total_supply_usd=lb.get("totalSupplyUsd"),
                    total_borrow_usd=lb.get("totalBorrowUsd"),
                    utilization=lb.get("utilization"),
                    apy_7d=p.get("apyBase7d"),
                    volume_usd_1d=p.get("volumeUsd1d"),
                )

                pool.risk_score = self._score_risk(pool)
                self.pools.append(pool)

            progress.update(task, description=f"[green]✓ {len(self.pools)} pools loaded across {len(set(p.chain for p in self.pools))} chains[/green]")

        self.last_fetch = datetime.now()

    def _infer_category(self, project: str) -> str:
        p = project.lower()
        if any(x in p for x in ["aave", "compound", "morpho", "euler", "silo", "radiant", "benqi", "venus", "moonwell", "spark", "fluid", "seamless"]):
            return "lending"
        if any(x in p for x in ["curve", "uniswap", "sushi", "balancer", "aerodrome", "velodrome", "camelot", "pancake", "trader-joe"]):
            return "dex"
        if any(x in p for x in ["lido", "rocket", "staked", "sfrx", "cbeth", "reth"]):
            return "staking"
        if any(x in p for x in ["convex", "yearn", "beefy", "harvest", "sommelier", "concentrator"]):
            return "yield"
        if any(x in p for x in ["pendle"]):
            return "fixed-yield"
        if any(x in p for x in ["eigen", "renzo", "ether.fi", "kelp", "puffer", "swell"]):
            return "restaking"
        if any(x in p for x in ["ondo", "mountain", "centrifuge", "maple", "goldfinch"]):
            return "rwa"
        return "other"

    def _score_risk(self, pool: YieldPool) -> int:
        score = 5  # baseline

        # Protocol reputation
        if pool.project in BLUE_CHIP:
            score -= 3
        elif pool.project in ESTABLISHED:
            score -= 1

        # TVL signal
        if pool.tvl > 100_000_000:
            score -= 1
        elif pool.tvl > 10_000_000:
            score -= 0
        elif pool.tvl < 1_000_000:
            score += 1
        if pool.tvl < 100_000:
            score += 1

        # Yield sustainability
        if pool.apy > 50:
            score += 2
        elif pool.apy > 20:
            score += 1

        if pool.apy_reward > pool.apy_base and pool.apy > 10:
            score += 1  # emission-dependent

        # IL risk
        if pool.il_risk:
            score += 1

        # Stablecoin = safer base
        if pool.stablecoin:
            score -= 1

        return max(1, min(10, score))

    # ── FILTERS ──

    def filter_pools(
        self,
        category: Optional[str] = None,
        chains: Optional[list[str]] = None,
        stablecoin_only: bool = False,
        min_tvl: float = 0,
        max_risk: int = 10,
        min_apy: float = 0,
        max_apy: float = 10000,
        symbols: Optional[list[str]] = None,
        projects: Optional[list[str]] = None,
        exclude_projects: Optional[list[str]] = None,
        sustainable_only: bool = False,
        single_sided_only: bool = False,
    ) -> list[YieldPool]:
        results = self.pools
        if category:
            results = [p for p in results if p.pool_category == category]
        if chains:
            chain_lower = [c.lower() for c in chains]
            results = [p for p in results if p.chain.lower() in chain_lower or p.chain_short.lower() in chain_lower]
        if stablecoin_only:
            results = [p for p in results if p.stablecoin]
        if min_tvl:
            results = [p for p in results if p.tvl >= min_tvl]
        if max_risk < 10:
            results = [p for p in results if p.risk_score <= max_risk]
        if min_apy > 0:
            results = [p for p in results if p.apy >= min_apy]
        if max_apy < 10000:
            results = [p for p in results if p.apy <= max_apy]
        if symbols:
            sym_upper = [s.upper() for s in symbols]
            results = [p for p in results if any(s in p.symbol.upper() for s in sym_upper)]
        if projects:
            proj_lower = [pr.lower() for pr in projects]
            results = [p for p in results if p.project.lower() in proj_lower]
        if exclude_projects:
            exc_lower = [pr.lower() for pr in exclude_projects]
            results = [p for p in results if p.project.lower() not in exc_lower]
        if sustainable_only:
            results = [p for p in results if p.is_sustainable]
        if single_sided_only:
            results = [p for p in results if p.exposure == "single"]
        return results

    # ── LOOPING CALCULATOR ──

    def calculate_looping(
        self,
        pool: YieldPool,
        max_loops: int = 7,
        safety_margin: float = 0.05,
    ) -> Optional[LoopingStrategy]:
        """Calculate leveraged looping yield for a lending pool."""
        if not pool.borrow_rate or not pool.ltv or pool.ltv <= 0:
            return None

        supply_apy = pool.apy / 100
        borrow_apy = pool.borrow_rate / 100
        ltv = pool.ltv

        if borrow_apy >= supply_apy:
            return None  # unprofitable loop

        best = None
        for loops in range(1, max_loops + 1):
            leverage = sum(ltv ** i for i in range(loops + 1))
            net = supply_apy * leverage - borrow_apy * (leverage - 1)
            liq_buffer = 1.0 - (ltv ** loops) / ltv  # simplified

            strategy = LoopingStrategy(
                pool=pool,
                loops=loops,
                net_apy=net * 100,
                leverage=leverage,
                liquidation_buffer=max(0, liq_buffer),
                supply_apy=pool.apy,
                borrow_apy=pool.borrow_rate,
                ltv=pool.ltv,
            )

            if best is None or strategy.net_apy > best.net_apy:
                if strategy.liquidation_buffer > safety_margin:
                    best = strategy

        return best

    def find_looping_opportunities(
        self,
        stablecoin_only: bool = True,
        min_tvl: float = 1_000_000,
        max_risk: int = 5,
    ) -> list[LoopingStrategy]:
        """Find all profitable looping strategies."""
        lending_pools = self.filter_pools(
            category="lending",
            stablecoin_only=stablecoin_only,
            min_tvl=min_tvl,
            max_risk=max_risk,
        )

        strategies = []
        for pool in lending_pools:
            strategy = self.calculate_looping(pool)
            if strategy and strategy.net_apy > pool.apy:
                strategies.append(strategy)

        return sorted(strategies, key=lambda s: s.net_apy, reverse=True)

    # ── CROSS-PROTOCOL ARBITRAGE ──

    def find_borrow_lend_arb(self, min_spread: float = 1.0, min_tvl: float = 5_000_000) -> list[dict]:
        """Find borrow on A, lend on B arbitrage opportunities."""
        lending_pools = [p for p in self.pools if p.pool_category == "lending" and p.tvl >= min_tvl]

        # Group by symbol
        by_symbol = {}
        for p in lending_pools:
            base_sym = p.symbol.split("-")[0].upper().strip()
            if base_sym not in by_symbol:
                by_symbol[base_sym] = []
            by_symbol[base_sym].append(p)

        arbs = []
        for sym, pools in by_symbol.items():
            borrow_pools = [p for p in pools if p.borrow_rate is not None]
            supply_pools = sorted(pools, key=lambda p: p.apy, reverse=True)

            for bp in borrow_pools:
                for sp in supply_pools:
                    if sp.pool_id == bp.pool_id:
                        continue
                    spread = sp.apy - bp.borrow_rate
                    if spread >= min_spread:
                        arbs.append({
                            "symbol": sym,
                            "borrow_from": bp.project,
                            "borrow_chain": bp.chain_short,
                            "borrow_rate": bp.borrow_rate,
                            "lend_to": sp.project,
                            "lend_chain": sp.chain_short,
                            "lend_rate": sp.apy,
                            "spread": spread,
                            "borrow_tvl": bp.tvl,
                            "lend_tvl": sp.tvl,
                            "risk": max(bp.risk_score, sp.risk_score),
                        })

        return sorted(arbs, key=lambda a: a["spread"], reverse=True)

    # ── SUMMARY STATS ──

    def get_market_summary(self) -> dict:
        if not self.pools:
            return {}

        stables = [p for p in self.pools if p.stablecoin]
        lending = [p for p in self.pools if p.pool_category == "lending"]
        lp = [p for p in self.pools if p.pool_category == "dex"]

        total_tvl = sum(p.tvl for p in self.pools)
        stable_tvl = sum(p.tvl for p in stables)

        stable_yields = [p.apy for p in stables if p.apy > 0 and p.apy < 100]
        lending_yields = [p.apy for p in lending if p.apy > 0 and p.apy < 100]

        return {
            "total_pools": len(self.pools),
            "total_tvl": total_tvl,
            "chains": len(set(p.chain for p in self.pools)),
            "protocols": len(set(p.project for p in self.pools)),
            "stable_pools": len(stables),
            "stable_tvl": stable_tvl,
            "stable_avg_yield": sum(stable_yields) / len(stable_yields) if stable_yields else 0,
            "stable_median_yield": sorted(stable_yields)[len(stable_yields) // 2] if stable_yields else 0,
            "lending_avg_yield": sum(lending_yields) / len(lending_yields) if lending_yields else 0,
            "lp_pools": len(lp),
            "timestamp": datetime.now().isoformat(),
        }


# ═══════════════════════════════════════════
# DISPLAY LAYER
# ═══════════════════════════════════════════

def fmt_usd(val: float) -> str:
    if val >= 1_000_000_000:
        return f"${val / 1_000_000_000:.1f}B"
    if val >= 1_000_000:
        return f"${val / 1_000_000:.1f}M"
    if val >= 1_000:
        return f"${val / 1_000:.0f}K"
    return f"${val:.0f}"


def fmt_pct(val: float) -> str:
    if val is None:
        return "—"
    return f"{val:.2f}%"


def display_pools_table(pools: list[YieldPool], title: str = "Yield Opportunities", max_rows: int = 40):
    if not pools:
        console.print("[dim]No pools match the criteria.[/dim]")
        return

    table = Table(
        title=f"[bold]{title}[/bold]  [dim]({len(pools)} results)[/dim]",
        box=box.SIMPLE_HEAVY,
        show_lines=False,
        pad_edge=True,
        header_style="bold cyan",
    )

    table.add_column("Protocol", style="bold white", max_width=18)
    table.add_column("Chain", style="dim", justify="center", max_width=7)
    table.add_column("Asset", max_width=22)
    table.add_column("APY", justify="right", style="green")
    table.add_column("Base", justify="right", style="dim")
    table.add_column("Reward", justify="right", style="yellow")
    table.add_column("30d Avg", justify="right", style="dim")
    table.add_column("TVL", justify="right")
    table.add_column("Risk", justify="center")
    table.add_column("Type", style="dim", max_width=10)

    for pool in pools[:max_rows]:
        apy_color = "green" if pool.apy < 15 else "yellow" if pool.apy < 30 else "red"
        tvl_color = "white" if pool.tvl > 10_000_000 else "dim"

        table.add_row(
            pool.project,
            pool.chain_short,
            pool.symbol[:22],
            f"[{apy_color}]{fmt_pct(pool.apy)}[/{apy_color}]",
            fmt_pct(pool.apy_base),
            fmt_pct(pool.apy_reward) if pool.apy_reward else "—",
            fmt_pct(pool.apy_mean_30d),
            f"[{tvl_color}]{fmt_usd(pool.tvl)}[/{tvl_color}]",
            pool.risk_label,
            pool.pool_category[:10],
        )

    console.print(table)

    if len(pools) > max_rows:
        console.print(f"[dim]  ... and {len(pools) - max_rows} more. Use --top N to see more.[/dim]")


def display_lending_table(pools: list[YieldPool], title: str = "Lending & Borrowing Rates"):
    lending = [p for p in pools if p.borrow_rate is not None]
    if not lending:
        console.print("[dim]No lending data available for these pools.[/dim]")
        return

    table = Table(
        title=f"[bold]{title}[/bold]",
        box=box.SIMPLE_HEAVY,
        header_style="bold cyan",
    )

    table.add_column("Protocol", style="bold white", max_width=18)
    table.add_column("Chain", style="dim", justify="center")
    table.add_column("Asset", max_width=14)
    table.add_column("Supply APY", justify="right", style="green")
    table.add_column("Borrow APY", justify="right", style="red")
    table.add_column("Spread", justify="right", style="yellow")
    table.add_column("LTV", justify="right")
    table.add_column("Util.", justify="right", style="dim")
    table.add_column("TVL", justify="right")
    table.add_column("Risk", justify="center")

    for p in lending[:40]:
        spread = p.apy - p.borrow_rate if p.borrow_rate else 0
        util_str = f"{p.utilization:.0%}" if p.utilization else "—"

        table.add_row(
            p.project,
            p.chain_short,
            p.symbol[:14],
            fmt_pct(p.apy),
            fmt_pct(p.borrow_rate),
            fmt_pct(spread),
            f"{p.ltv:.0%}" if p.ltv else "—",
            util_str,
            fmt_usd(p.tvl),
            p.risk_label,
        )

    console.print(table)


def display_looping_table(strategies: list[LoopingStrategy]):
    if not strategies:
        console.print("[dim]No profitable looping strategies found with current rates.[/dim]")
        return

    table = Table(
        title="[bold]Looping Strategies[/bold]  [dim](leveraged lending)[/dim]",
        box=box.SIMPLE_HEAVY,
        header_style="bold cyan",
    )

    table.add_column("Protocol", style="bold white")
    table.add_column("Chain", style="dim", justify="center")
    table.add_column("Asset")
    table.add_column("Base APY", justify="right", style="dim")
    table.add_column("Loops", justify="center")
    table.add_column("Leverage", justify="right")
    table.add_column("Net APY", justify="right", style="bold green")
    table.add_column("Borrow Rate", justify="right", style="red")
    table.add_column("LTV", justify="right")
    table.add_column("TVL", justify="right")
    table.add_column("Risk", justify="center")

    for s in strategies[:30]:
        table.add_row(
            s.pool.project,
            s.pool.chain_short,
            s.pool.symbol[:16],
            fmt_pct(s.supply_apy),
            str(s.loops),
            f"{s.leverage:.1f}x",
            f"[bold green]{fmt_pct(s.net_apy)}[/bold green]",
            fmt_pct(s.borrow_apy),
            f"{s.ltv:.0%}" if s.ltv else "—",
            fmt_usd(s.pool.tvl),
            s.pool.risk_label,
        )

    console.print(table)


def display_arb_table(arbs: list[dict]):
    if not arbs:
        console.print("[dim]No borrow/lend arbitrage opportunities at current rates.[/dim]")
        return

    table = Table(
        title="[bold]Borrow → Lend Arbitrage[/bold]",
        box=box.SIMPLE_HEAVY,
        header_style="bold cyan",
    )

    table.add_column("Asset", style="bold white")
    table.add_column("Borrow From", style="red")
    table.add_column("Rate", justify="right", style="red")
    table.add_column("→")
    table.add_column("Lend To", style="green")
    table.add_column("Rate", justify="right", style="green")
    table.add_column("Spread", justify="right", style="bold yellow")
    table.add_column("Risk")

    for a in arbs[:25]:
        risk_score = a["risk"]
        risk_label = "🟢" if risk_score <= 3 else "🟡" if risk_score <= 5 else "🔴"
        table.add_row(
            a["symbol"],
            f"{a['borrow_from']} ({a['borrow_chain']})",
            fmt_pct(a["borrow_rate"]),
            "→",
            f"{a['lend_to']} ({a['lend_chain']})",
            fmt_pct(a["lend_rate"]),
            fmt_pct(a["spread"]),
            risk_label,
        )

    console.print(table)


def display_summary(scanner: DefiScanner):
    s = scanner.get_market_summary()
    if not s:
        return

    console.print(Panel(
        f"""[bold white]DeFi Yield Market Overview[/bold white]  [dim]{datetime.now().strftime('%b %d, %Y %H:%M UTC')}[/dim]

[cyan]Total Pools:[/cyan]  {s['total_pools']:,}  across  [cyan]{s['chains']}[/cyan] chains  and  [cyan]{s['protocols']}[/cyan] protocols
[cyan]Total TVL:[/cyan]    {fmt_usd(s['total_tvl'])}

[bold]Stablecoins[/bold]
  Pools: {s['stable_pools']:,}   TVL: {fmt_usd(s['stable_tvl'])}
  Avg Yield: [green]{s['stable_avg_yield']:.2f}%[/green]   Median: [green]{s['stable_median_yield']:.2f}%[/green]

[bold]Lending[/bold]
  Avg Supply Rate: [green]{s['lending_avg_yield']:.2f}%[/green]

[bold]LP Pools:[/bold]  {s['lp_pools']:,}""",
        title="◈ Market Scan",
        border_style="green",
        padding=(1, 2),
    ))


# ═══════════════════════════════════════════
# REPORT GENERATION
# ═══════════════════════════════════════════

def generate_report(scanner: DefiScanner, output_path: str = "defi_report.md"):
    """Generate a full markdown report."""
    s = scanner.get_market_summary()
    lines = []
    lines.append(f"# DeFi Yield Report — {datetime.now().strftime('%B %d, %Y')}\n")
    lines.append(f"Scanned {s['total_pools']:,} pools across {s['chains']} chains and {s['protocols']} protocols.\n")
    lines.append(f"Total TVL tracked: {fmt_usd(s['total_tvl'])}\n")

    # Top stablecoin yields
    lines.append("\n## Top Stablecoin Yields (Safe)\n")
    lines.append("| Protocol | Chain | Asset | APY | TVL | Risk |")
    lines.append("|----------|-------|-------|-----|-----|------|")
    safe_stables = scanner.filter_pools(stablecoin_only=True, min_tvl=1_000_000, max_risk=4)
    safe_stables.sort(key=lambda p: p.apy, reverse=True)
    for p in safe_stables[:20]:
        lines.append(f"| {p.project} | {p.chain_short} | {p.symbol} | {fmt_pct(p.apy)} | {fmt_usd(p.tvl)} | {p.risk_label} |")

    # Top LP opportunities
    lines.append("\n## Top LP Opportunities\n")
    lines.append("| Protocol | Chain | Pair | APY | Base | Reward | TVL | Risk |")
    lines.append("|----------|-------|------|-----|------|--------|-----|------|")
    lps = scanner.filter_pools(category="dex", min_tvl=500_000)
    lps.sort(key=lambda p: p.apy, reverse=True)
    for p in lps[:20]:
        lines.append(f"| {p.project} | {p.chain_short} | {p.symbol} | {fmt_pct(p.apy)} | {fmt_pct(p.apy_base)} | {fmt_pct(p.apy_reward)} | {fmt_usd(p.tvl)} | {p.risk_label} |")

    # Looping strategies
    lines.append("\n## Looping Strategies\n")
    lines.append("| Protocol | Chain | Asset | Base APY | Loops | Net APY | Leverage |")
    lines.append("|----------|-------|-------|----------|-------|---------|----------|")
    loops = scanner.find_looping_opportunities(min_tvl=5_000_000)
    for s in loops[:15]:
        lines.append(f"| {s.pool.project} | {s.pool.chain_short} | {s.pool.symbol} | {fmt_pct(s.supply_apy)} | {s.loops} | {fmt_pct(s.net_apy)} | {s.leverage:.1f}x |")

    # Arbitrage
    lines.append("\n## Borrow/Lend Arbitrage\n")
    lines.append("| Asset | Borrow From | Rate | Lend To | Rate | Spread |")
    lines.append("|-------|-------------|------|---------|------|--------|")
    arbs = scanner.find_borrow_lend_arb(min_spread=0.5)
    for a in arbs[:15]:
        lines.append(f"| {a['symbol']} | {a['borrow_from']} ({a['borrow_chain']}) | {fmt_pct(a['borrow_rate'])} | {a['lend_to']} ({a['lend_chain']}) | {fmt_pct(a['lend_rate'])} | {fmt_pct(a['spread'])} |")

    lines.append(f"\n---\n*Generated {datetime.now().strftime('%Y-%m-%d %H:%M')} UTC*\n")

    report = "\n".join(lines)
    with open(output_path, "w") as f:
        f.write(report)
    console.print(f"[green]Report saved to {output_path}[/green]")
    return report


# ═══════════════════════════════════════════
# AI ANALYSIS LAYER
# ═══════════════════════════════════════════

def ai_analyze(scanner: DefiScanner, query: str):
    """Use Anthropic API to analyze data with web search for latest context."""
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        console.print("[yellow]ANTHROPIC_API_KEY not set — running without AI analysis.[/yellow]")
        console.print("[dim]Set it for natural language queries and AI-powered insights.[/dim]")
        return

    import anthropic
    client = anthropic.Anthropic()

    # Build context from scanner data
    summary = scanner.get_market_summary()
    top_stable = scanner.filter_pools(stablecoin_only=True, min_tvl=1_000_000, max_risk=5)
    top_stable.sort(key=lambda p: p.apy, reverse=True)

    context = f"""Current DeFi market data (live from DefiLlama):
- Total pools scanned: {summary.get('total_pools', 0)}
- Chains: {summary.get('chains', 0)}, Protocols: {summary.get('protocols', 0)}
- Stablecoin avg yield: {summary.get('stable_avg_yield', 0):.2f}%
- Stablecoin median yield: {summary.get('stable_median_yield', 0):.2f}%

Top 15 stablecoin yields (>$1M TVL, risk ≤5):
"""
    for p in top_stable[:15]:
        context += f"  {p.project} ({p.chain_short}) — {p.symbol}: {p.apy:.2f}% APY, TVL {fmt_usd(p.tvl)}, risk {p.risk_score}/10\n"

    # Top lending rates
    lending = scanner.filter_pools(category="lending", stablecoin_only=True, min_tvl=5_000_000)
    lending.sort(key=lambda p: p.apy, reverse=True)
    context += "\nTop lending supply rates:\n"
    for p in lending[:10]:
        borrow_str = f", borrow {p.borrow_rate:.2f}%" if p.borrow_rate else ""
        context += f"  {p.project} ({p.chain_short}) — {p.symbol}: supply {p.apy:.2f}%{borrow_str}, TVL {fmt_usd(p.tvl)}\n"

    system = f"""You are a DeFi research analyst for Minted, an institutional stablecoin protocol.
You have access to live yield data AND web search for additional context.

{context}

When answering:
1. Use the provided data as your primary source
2. Use web search to verify, get latest news, or find additional context
3. Be direct and analytical — lead with numbers
4. Always assess risk alongside yield
5. If something looks too good to be true, say so
6. Consider sustainability of yields (base vs reward emissions)"""

    with console.status("[green]Analyzing with AI + web search...", spinner="dots"):
        try:
            response = client.messages.create(
                model=ANTHROPIC_MODEL,
                max_tokens=MAX_TOKENS,
                system=system,
                messages=[{"role": "user", "content": query}],
                tools=[{"type": "web_search_20250305", "name": "web_search"}],
            )

            text_parts = []
            for block in response.content:
                if getattr(block, "type", "") == "text":
                    text_parts.append(block.text)

            result = "\n\n".join(text_parts)
            console.print()
            console.print(Markdown(result))
            console.print()

        except Exception as e:
            console.print(f"[red]AI analysis error: {e}[/red]")


# ═══════════════════════════════════════════
# INTERACTIVE MODE
# ═══════════════════════════════════════════

def interactive(scanner: DefiScanner):
    console.print(Panel(
        "[bold]Commands[/bold]\n\n"
        "  [cyan]scan[/cyan]              Full yield scan\n"
        "  [cyan]stables[/cyan]           Stablecoin yields\n"
        "  [cyan]lending[/cyan]           Lending/borrowing rates\n"
        "  [cyan]lp[/cyan]               LP opportunities\n"
        "  [cyan]looping[/cyan]           Leveraged looping strategies\n"
        "  [cyan]arb[/cyan]              Borrow/lend arbitrage\n"
        "  [cyan]rwa[/cyan]              RWA/tokenized yields\n"
        "  [cyan]watch USDC[/cyan]       Track specific asset\n"
        "  [cyan]compare a b[/cyan]      Compare two protocols\n"
        "  [cyan]report[/cyan]           Generate full markdown report\n"
        "  [cyan]refresh[/cyan]          Re-fetch latest data\n"
        "  [cyan]summary[/cyan]          Market overview\n"
        "  [cyan]quit[/cyan]             Exit\n\n"
        "[dim]Or type any question for AI-powered analysis[/dim]",
        title="◈ Minted DeFi Research Agent",
        border_style="green",
        padding=(1, 2),
    ))

    scanner.fetch_all()
    display_summary(scanner)
    console.print()

    while True:
        try:
            cmd = console.input("[green]>[/green] ").strip()
        except (KeyboardInterrupt, EOFError):
            console.print("\n[dim]Exiting.[/dim]")
            break

        if not cmd:
            continue

        parts = cmd.lower().split()
        action = parts[0]

        if action in ("quit", "exit", "q"):
            break

        elif action == "scan":
            top_n = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 30
            pools = sorted(scanner.pools, key=lambda p: p.apy, reverse=True)
            display_pools_table(pools, "Full Yield Scan — All Protocols", max_rows=top_n)

        elif action == "stables":
            min_tvl = 100_000
            max_risk = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 10
            pools = scanner.filter_pools(stablecoin_only=True, min_tvl=min_tvl, max_risk=max_risk)
            pools.sort(key=lambda p: p.apy, reverse=True)
            display_pools_table(pools, "Stablecoin Yields")

        elif action == "safe":
            pools = scanner.filter_pools(stablecoin_only=True, min_tvl=1_000_000, max_risk=4, sustainable_only=True)
            pools.sort(key=lambda p: p.apy, reverse=True)
            display_pools_table(pools, "Safe Stablecoin Yields (low risk, sustainable)")

        elif action == "lending":
            pools = scanner.filter_pools(category="lending", min_tvl=500_000)
            pools.sort(key=lambda p: p.apy, reverse=True)
            display_lending_table(pools)

        elif action == "lp":
            min_tvl = 100_000
            pools = scanner.filter_pools(category="dex", min_tvl=min_tvl)
            pools.sort(key=lambda p: p.apy, reverse=True)
            display_pools_table(pools, "LP Opportunities — All DEXs")

        elif action == "looping":
            stable_only = "--all" not in parts
            strategies = scanner.find_looping_opportunities(stablecoin_only=stable_only)
            display_looping_table(strategies)

        elif action == "arb":
            min_spread = float(parts[1]) if len(parts) > 1 else 0.5
            arbs = scanner.find_borrow_lend_arb(min_spread=min_spread)
            display_arb_table(arbs)

        elif action == "rwa":
            pools = scanner.filter_pools(
                symbols=["USDY", "USDM", "BUIDL", "SDAI", "SUSDS", "USD0", "USDE", "SUSDE", "OUSG"],
                min_tvl=100_000,
            )
            pools.sort(key=lambda p: p.apy, reverse=True)
            display_pools_table(pools, "RWA & Tokenized Yields")

        elif action == "watch":
            if len(parts) < 2:
                console.print("[dim]Usage: watch USDC[/dim]")
                continue
            symbol = parts[1].upper()
            pools = scanner.filter_pools(symbols=[symbol], min_tvl=100_000)
            pools.sort(key=lambda p: p.apy, reverse=True)
            display_pools_table(pools, f"All {symbol} Opportunities")
            # Also show lending
            lending = [p for p in pools if p.borrow_rate is not None]
            if lending:
                display_lending_table(lending, f"{symbol} Lending/Borrowing")

        elif action == "compare":
            if len(parts) < 3:
                console.print("[dim]Usage: compare aave morpho[/dim]")
                continue
            p1, p2 = parts[1], parts[2]
            pools1 = scanner.filter_pools(projects=[p1])
            pools2 = scanner.filter_pools(projects=[p2])
            if not pools1 and not pools2:
                # try partial match
                pools1 = [p for p in scanner.pools if p1 in p.project.lower()]
                pools2 = [p for p in scanner.pools if p2 in p.project.lower()]
            combined = pools1 + pools2
            combined.sort(key=lambda p: p.apy, reverse=True)
            proj_names = set(p.project for p in combined)
            display_pools_table(combined, f"Comparison: {' vs '.join(proj_names)}")

        elif action == "summary":
            display_summary(scanner)

        elif action == "refresh":
            scanner.fetch_all(force=True)
            display_summary(scanner)

        elif action == "report":
            path = parts[1] if len(parts) > 1 else "defi_report.md"
            generate_report(scanner, path)

        elif action == "chains":
            chain_counts = {}
            for p in scanner.pools:
                chain_counts[p.chain] = chain_counts.get(p.chain, 0) + 1
            for chain, count in sorted(chain_counts.items(), key=lambda x: x[1], reverse=True)[:20]:
                console.print(f"  {CHAIN_SHORT.get(chain, chain):<10} {count:>5} pools")

        elif action == "protocols":
            proto_tvl = {}
            for p in scanner.pools:
                proto_tvl[p.project] = proto_tvl.get(p.project, 0) + p.tvl
            for proto, tvl in sorted(proto_tvl.items(), key=lambda x: x[1], reverse=True)[:30]:
                console.print(f"  {proto:<25} {fmt_usd(tvl):>10}")

        else:
            # Anything else → AI analysis
            ai_analyze(scanner, cmd)


# ═══════════════════════════════════════════
# CLI
# ═══════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description="Minted DeFi Research Agent")
    parser.add_argument("command", nargs="?", default="interactive",
                        help="Command: scan, lending, lp, looping, stables, arb, rwa, report, watch, compare, or interactive")
    parser.add_argument("args", nargs="*", help="Additional arguments")
    parser.add_argument("--top", type=int, default=30, help="Number of results to show")
    parser.add_argument("--min-tvl", type=float, default=100_000, help="Minimum TVL filter")
    parser.add_argument("--max-risk", type=int, default=10, help="Maximum risk score (1-10)")
    parser.add_argument("--chain", type=str, help="Filter by chain")
    parser.add_argument("--safe", action="store_true", help="Safe yields only (risk ≤ 4, sustainable)")
    parser.add_argument("--json", action="store_true", help="Output as JSON")

    args = parser.parse_args()

    scanner = DefiScanner()

    if args.command == "interactive":
        interactive(scanner)
        return

    # All other commands need data
    scanner.fetch_all()

    chains = [args.chain] if args.chain else None
    max_risk = 4 if args.safe else args.max_risk

    if args.command == "scan":
        pools = scanner.filter_pools(min_tvl=args.min_tvl, max_risk=max_risk, chains=chains)
        pools.sort(key=lambda p: p.apy, reverse=True)
        if args.json:
            print(json.dumps([{"project": p.project, "chain": p.chain, "symbol": p.symbol, "apy": p.apy, "tvl": p.tvl, "risk": p.risk_score} for p in pools[:args.top]], indent=2))
        else:
            display_summary(scanner)
            display_pools_table(pools, "Full Yield Scan", max_rows=args.top)

    elif args.command == "lending":
        pools = scanner.filter_pools(category="lending", min_tvl=args.min_tvl, max_risk=max_risk, chains=chains)
        pools.sort(key=lambda p: p.apy, reverse=True)
        display_lending_table(pools)

    elif args.command == "lp":
        pools = scanner.filter_pools(category="dex", min_tvl=args.min_tvl, max_risk=max_risk, chains=chains)
        pools.sort(key=lambda p: p.apy, reverse=True)
        display_pools_table(pools, "LP Opportunities", max_rows=args.top)

    elif args.command == "looping":
        strategies = scanner.find_looping_opportunities(min_tvl=args.min_tvl, max_risk=max_risk)
        display_looping_table(strategies)

    elif args.command == "stables":
        pools = scanner.filter_pools(stablecoin_only=True, min_tvl=args.min_tvl, max_risk=max_risk, chains=chains)
        pools.sort(key=lambda p: p.apy, reverse=True)
        display_pools_table(pools, "Stablecoin Yields", max_rows=args.top)

    elif args.command == "arb":
        min_spread = float(args.args[0]) if args.args else 0.5
        arbs = scanner.find_borrow_lend_arb(min_spread=min_spread, min_tvl=args.min_tvl)
        display_arb_table(arbs)

    elif args.command == "rwa":
        pools = scanner.filter_pools(
            symbols=["USDY", "USDM", "BUIDL", "SDAI", "SUSDS", "USD0", "USDE", "SUSDE", "OUSG"],
            min_tvl=args.min_tvl,
        )
        pools.sort(key=lambda p: p.apy, reverse=True)
        display_pools_table(pools, "RWA & Tokenized Yields", max_rows=args.top)

    elif args.command == "watch":
        if not args.args:
            console.print("[red]Usage: defi_scanner.py watch USDC[/red]")
            return
        symbol = args.args[0].upper()
        pools = scanner.filter_pools(symbols=[symbol], min_tvl=args.min_tvl)
        pools.sort(key=lambda p: p.apy, reverse=True)
        display_pools_table(pools, f"{symbol} Opportunities", max_rows=args.top)

    elif args.command == "compare":
        if len(args.args) < 2:
            console.print("[red]Usage: defi_scanner.py compare aave morpho[/red]")
            return
        pools = []
        for name in args.args:
            matched = [p for p in scanner.pools if name.lower() in p.project.lower()]
            pools.extend(matched)
        pools.sort(key=lambda p: p.apy, reverse=True)
        display_pools_table(pools, f"Comparison: {' vs '.join(args.args)}", max_rows=args.top)

    elif args.command == "report":
        path = args.args[0] if args.args else "defi_report.md"
        generate_report(scanner, path)

    else:
        # Treat as natural language query
        ai_analyze(scanner, " ".join([args.command] + args.args))


if __name__ == "__main__":
    main()
    '
tools: []
---
Define what this custom agent accomplishes for the user, when to use it, and the edges it won't cross. Specify its ideal inputs/outputs, the tools it may call, and how it reports progress or asks for help.