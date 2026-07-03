#!/usr/bin/env python3
"""Alpha-Life Engine — Local GPU Strategy Evolver CLI.

Usage:
    export SESSION_TOKEN="your_token_here"
    python scripts/local_evolver/evolver.py --api-url http://localhost:8787

Options:
    --api-url       Backend API base URL (default: http://localhost:8787)
    --gbm-paths     Number of GBM paths (default: 10000)
    --wf-sets       Number of walk-forward parameter sets (default: 200)
    --frontier-pts  Number of efficient frontier points (default: 50)
    --no-push       Dry-run: generate report but don't push to cloud
"""

import os
import sys

import click
import torch
from api_client import TRACKED_SYMBOLS, fetch_market_data
from config import load_config
from dsr import compute_haircut_sharpe
from models import DataFrame
from report import generate_report, push_report_to_cloud, serialize_report


@click.command()
@click.option(
    "--api-url",
    default="http://localhost:8787",
    show_default=True,
    help="Backend API base URL (without /api prefix)",
)
@click.option(
    "--gbm-paths",
    default=10000,
    type=int,
    show_default=True,
    help="Number of Monte Carlo GBM paths",
)
@click.option(
    "--wf-sets",
    default=200,
    type=int,
    show_default=True,
    help="Number of walk-forward parameter sets to evaluate",
)
@click.option(
    "--frontier-pts",
    default=50,
    type=int,
    show_default=True,
    help="Number of efficient frontier points",
)
@click.option(
    "--no-push",
    is_flag=True,
    default=False,
    help="Generate report locally without pushing to cloud",
)
def main(
    api_url: str,
    gbm_paths: int,
    wf_sets: int,
    frontier_pts: int,
    *,
    no_push: bool = False,
) -> None:
    token = os.environ.get("SESSION_TOKEN")
    if not token:
        click.echo("ERROR: SESSION_TOKEN environment variable is not set.", err=True)
        click.echo("Login via web UI and copy the session_token cookie.", err=True)
        sys.exit(1)

    click.echo(f"Connecting to backend: {api_url}")
    click.echo(f"GPU available: {torch.cuda.is_available()}")
    if torch.cuda.is_available():
        click.echo(f"GPU device: {torch.cuda.get_device_name(0)}")

    click.echo("\nFetching market data from backend...")
    data = fetch_market_data(api_url)
    click.echo(f"  Loaded {len(data.symbols)} symbols")

    empty_symbols = [
        s for s in TRACKED_SYMBOLS if s not in data.symbols or not data.symbols[s].close
    ]
    if empty_symbols:
        click.echo(
            f"  WARNING: {len(empty_symbols)} symbol(s) have no data: {empty_symbols}",
            err=True,
        )
    if all(
        not data.symbols.get(
            s, DataFrame(dates=[], close=[], open=[], high=[], low=[], volume=[])
        ).close
        for s in TRACKED_SYMBOLS
    ):
        msg = "All symbols have no market data. Cannot proceed with evolution."
        raise RuntimeError(msg)

    config = load_config()
    config.gbm_paths = gbm_paths
    config.frontier_points = frontier_pts
    config.walk_forward_param_sets = wf_sets

    click.echo("\nRunning strategy evolution pipeline...")
    click.echo(f"  GBM paths: {config.gbm_paths}")
    click.echo(f"  Walk-forward sets: {wf_sets}")
    click.echo(f"  Frontier points: {config.frontier_points}")

    symbols = TRACKED_SYMBOLS

    click.echo("  Step 1/4: Efficient frontier (GPU)...")
    report = generate_report(data, symbols, config)

    click.echo("  Step 2/4: Monte Carlo stress test (GPU)...")
    click.echo(f"    Mean return: {report.monte_carlo_result.summary.mean_return:.4%}")
    click.echo(f"    VaR 95: {report.monte_carlo_result.summary.var95:.4%}")
    click.echo(f"    VaR 99: {report.monte_carlo_result.summary.var99:.4%}")
    click.echo(f"    CVaR 95: {report.cvar_result.cvar_95:.4%}")
    click.echo(
        f"    Max drawdown: {report.monte_carlo_result.summary.max_drawdown:.4%}"
    )
    click.echo(f"    Ulcer index: {report.drawdown_analytics.ulcer_index:.4f}")
    click.echo(f"    Calmar ratio: {report.drawdown_analytics.calmar_ratio:.4f}")

    click.echo("  Step 3/4: Walk-forward optimization (CPU)...")
    click.echo(f"    PBO score: {report.walk_forward_summary.pbo_score:.4f}")
    click.echo(
        f"    Stability score: {report.walk_forward_summary.stability_score:.4f}"
    )
    click.echo(
        f"    Haircut Sharpe: {compute_haircut_sharpe(report.walk_forward_summary.dsr_rankings[0] if report.walk_forward_summary.dsr_rankings else 0.0, config.walk_forward_param_sets):.4f}"
    )

    click.echo("  Step 4/4: Stability & regime check...")
    click.echo(f"    Gradient: {report.stability_report.gradient:.4f}")
    click.echo(f"    Stable: {report.stability_report.is_stable}")
    click.echo(
        f"    Regime: {report.regime_result.regime_label} (probs: {[f'{p:.2f}' for p in report.regime_result.regime_probs]})"
    )
    click.echo(
        f"    Drift alert: {report.drift_result.alert} (PSI: {report.drift_result.psi:.4f})"
    )

    click.echo("\nRecommended parameters:")
    p = report.recommended_params
    click.echo(f"  Trigger line: {p.trigger_line}")
    click.echo(
        f"  Safe ratio: {p.safe_ratio:.2f} / Ambition ratio: {p.ambition_ratio:.2f}"
    )
    click.echo(f"  BSM threshold: {p.bsm_threshold:.2f}")
    click.echo(f"  MA window: {p.ma_short_window}/{p.ma_long_window}")

    if no_push:
        click.echo("\n--- DRY RUN: report not pushed to cloud ---")
        report_size = len(serialize_report(report)) / 1024
        click.echo(f"Report size: {report_size:.1f} KB")
    else:
        click.echo("\nPushing report to cloud...")
        result = push_report_to_cloud(report, api_url, token)
        if result["success"]:
            click.echo("  Report pushed successfully!")
        else:
            click.echo(f"  ERROR: {result.get('error', 'unknown')}", err=True)
            sys.exit(1)

    click.echo("\nDone.")


if __name__ == "__main__":
    main()
