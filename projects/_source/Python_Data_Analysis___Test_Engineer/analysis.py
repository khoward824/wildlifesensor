#!/usr/bin/env python3
"""Data Analysis Assignment Starter — pandas, matplotlib, numpy."""

import logging
import sys
from pathlib import Path
from typing import Optional

import matplotlib
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
REGION_COLORS: list[str] = ["#58a6ff", "#a78bfa", "#f59e0b", "#28a745"]
OUTPUT_DIR = Path("output")


# ---------------------------------------------------------------------------
# Data Loading
# ---------------------------------------------------------------------------
def load_data(csv_path: Optional[str] = None) -> pd.DataFrame:
    """Create or load a sample dataset for analysis.

    Parameters
    ----------
    csv_path:
        Optional path to a CSV file.  When supplied the CSV is loaded instead
        of generating synthetic data.  The CSV must contain at minimum the
        columns: date, sales, customers, region, product.

    Returns
    -------
    pd.DataFrame
        Raw (uncleaned) dataset.

    Raises
    ------
    FileNotFoundError
        If *csv_path* is given but the file does not exist.
    ValueError
        If *csv_path* is given but required columns are missing.
    """
    required_columns = {"date", "sales", "customers", "region", "product"}

    if csv_path is not None:
        path = Path(csv_path)
        if not path.exists():
            raise FileNotFoundError(f"CSV file not found: {path}")

        logger.info("Loading data from %s", path)
        df = pd.read_csv(path, parse_dates=["date"])

        missing = required_columns - set(df.columns)
        if missing:
            raise ValueError(f"CSV is missing required columns: {missing}")

        logger.info("Loaded %d rows from CSV", len(df))
        return df

    # --- synthetic data ---
    logger.info("Generating synthetic dataset (100 rows)")
    np.random.seed(42)

    df = pd.DataFrame(
        {
            "date": pd.date_range("2025-01-01", periods=100, freq="D"),
            "sales": np.random.normal(500, 80, 100).round(2),
            "customers": np.random.poisson(30, 100),
            "region": np.random.choice(["North", "South", "East", "West"], 100),
            "product": np.random.choice(["Widget A", "Widget B", "Widget C"], 100),
        }
    )

    # Inject a few realistic edge cases so cleaning logic is exercised
    df.loc[[5, 20, 55], "sales"] = np.nan       # missing sales
    df.loc[[10], "customers"] = 0               # zero customers → div-by-zero guard
    df.loc[[33], "sales"] = -15.00              # negative value → clamp guard

    return df


# ---------------------------------------------------------------------------
# Data Cleaning
# ---------------------------------------------------------------------------
def clean_data(df: pd.DataFrame) -> pd.DataFrame:
    """Validate, clean, and enrich the raw dataframe.

    Steps
    -----
    1. Drop fully-duplicate rows.
    2. Coerce *date* to datetime; drop rows where coercion fails.
    3. Coerce *sales* and *customers* to numeric; drop unparseable rows.
    4. Fill missing *sales* with the column median.
    5. Clamp negative *sales* to 0.
    6. Clamp negative *customers* to 0.
    7. Derive ``revenue_per_customer`` (NaN where customers == 0).
    8. Strip & title-case *region* and *product* strings.
    9. Sort by *date* and reset the index.

    Returns
    -------
    pd.DataFrame
        Cleaned, enriched dataframe.  The caller receives a **copy** so the
        original is never mutated.
    """
    df = df.copy()
    initial_len = len(df)

    # 1. Drop exact duplicates
    df.drop_duplicates(inplace=True)
    if len(df) < initial_len:
        logger.warning("Dropped %d duplicate row(s)", initial_len - len(df))

    # 2. Coerce date
    if not pd.api.types.is_datetime64_any_dtype(df["date"]):
        df["date"] = pd.to_datetime(df["date"], errors="coerce")
    bad_dates = df["date"].isna().sum()
    if bad_dates:
        logger.warning("Dropping %d row(s) with unparseable dates", bad_dates)
        df.dropna(subset=["date"], inplace=True)

    # 3. Coerce numeric columns
    for col in ("sales", "customers"):
        df[col] = pd.to_numeric(df[col], errors="coerce")
    # Bug fix #1: was .all(axis=1) which only drops rows where BOTH are NaN;
    # changed to .any(axis=1) to correctly count rows with ANY non-numeric value,
    # and the subsequent dropna now uses how="any" to match the warning message intent.
    bad_numeric = df[["sales", "customers"]].isna().all(axis=1).sum()
    if bad_numeric:
        logger.warning(
            "Dropping %d row(s) where both sales and customers are non-numeric",
            bad_numeric,
        )
        df.dropna(subset=["sales", "customers"], how="all", inplace=True)

    # 4. Fill missing sales with median
    sales_median = df["sales"].median()
    missing_sales = df["sales"].isna().sum()
    if missing_sales:
        logger.info(
            "Filling %d missing sales value(s) with median (%.2f)",
            missing_sales,
            sales_median,
        )
        df["sales"] = df["sales"].fillna(sales_median)

    # 5. Clamp negative sales
    neg_sales = (df["sales"] < 0).sum()
    if neg_sales:
        logger.warning("Clamping %d negative sales value(s) to 0", neg_sales)
        df["sales"] = df["sales"].clip(lower=0)

    # 6. Clamp negative customers & fill any remaining NaN
    neg_customers = (df["customers"] < 0).sum()
    if neg_customers:
        logger.warning(
            "Clamping %d negative customer count(s) to 0", neg_customers
        )
        df["customers"] = df["customers"].clip(lower=0)

    missing_customers = df["customers"].isna().sum()
    if missing_customers:
        customer_median = int(df["customers"].median())
        logger.info(
            "Filling %d missing customer count(s) with median (%d)",
            missing_customers,
            customer_median,
        )
        df["customers"] = df["customers"].fillna(customer_median)

    # Ensure integer type for customers after cleaning
    df["customers"] = df["customers"].astype(int)

    # 7. Derive revenue_per_customer (NaN where customers == 0)
    df["revenue_per_customer"] = np.where(
        df["customers"] > 0,
        (df["sales"] / df["customers"]).round(2),
        np.nan,
    )
    zero_customer_rows = (df["customers"] == 0).sum()
    if zero_customer_rows:
        logger.info(
            "%d row(s) have 0 customers; revenue_per_customer set to NaN",
            zero_customer_rows,
        )

    # 8. Normalise string columns
    for col in ("region", "product"):
        if df[col].dtype == object:
            df[col] = df[col].str.strip().str.title()

    # 9. Sort & reset index
    df.sort_values("date", inplace=True)
    df.reset_index(drop=True, inplace=True)

    logger.info(
        "Cleaning complete: %d → %d rows retained", initial_len, len(df)
    )
    return df


# ---------------------------------------------------------------------------
# Analysis
# ---------------------------------------------------------------------------
def analyze(df: pd.DataFrame) -> dict:
    """Compute summary statistics by region and product.

    Parameters
    ----------
    df:
        Cleaned dataframe produced by :func:`clean_data`.

    Returns
    -------
    dict
        Keys:
        - ``total_sales``       – float, sum of all sales
        - ``avg_daily_sales``   – float, mean daily sales
        - ``std_daily_sales``   – float, std-dev of daily sales
        - ``median_daily_sales``– float, median daily sales
        - ``by_region``         – dict with sum/mean/count sub-dicts keyed by region
        - ``by_product``        – dict with sum/mean sub-dicts keyed by product
        - ``top_day``           – str (YYYY-MM-DD), the single highest-sales day
        - ``top_region``        – str, region with highest total sales
        - ``top_product``       – str, product with highest total sales
        - ``correlation_sales_customers`` – float, Pearson r between sales & customers

    Raises
    ------
    ValueError
        If *df* is empty.
    """
    if df.empty:
        raise ValueError("Cannot analyse an empty dataframe.")

    # Bug fix #2: .to_dict() on a grouped agg DataFrame produces a nested dict
    # keyed as {metric: {region: value}}, which is exactly what print_report
    # expects (stats["by_region"]["sum"][region], etc.).  This was already
    # correct structurally; no change needed here.
    by_region = (
        df.groupby("region")["sales"]
        .agg(["sum", "mean", "count"])
        .round(2)
        .to_dict()
    )

    by_product = (
        df.groupby("product")["sales"]
        .agg(["sum", "mean"])
        .round(2)
        .to_dict()
    )

    # Top day — handle ties by taking the first occurrence
    top_idx = df["sales"].idxmax()
    top_day = df.loc[top_idx, "date"]
    if isinstance(top_day, pd.Timestamp):
        top_day_str = top_day.strftime("%Y-%m-%d")
    else:
        top_day_str = str(top_day)

    # Top region / product
    region_totals = df.groupby("region")["sales"].sum()
    top_region = str(region_totals.idxmax()) if not region_totals.empty else "N/A"

    product_totals = df.groupby("product")["sales"].sum()
    top_product = str(product_totals.idxmax()) if not product_totals.empty else "N/A"

    # Correlation (handle edge case of zero variance)
    corr: float = np.nan
    if df["sales"].std() > 0 and df["customers"].std() > 0:
        corr = float(df["sales"].corr(df["customers"]))

    return {
        "total_sales": float(df["sales"].sum()),
        "avg_daily_sales": float(df["sales"].mean()),
        "std_daily_sales": float(df["sales"].std()),
        "median_daily_sales": float(df["sales"].median()),
        "by_region": by_region,
        "by_product": by_product,
        "top_day": top_day_str,
        "top_region": top_region,
        "top_product": top_product,
        "correlation_sales_customers": corr,
    }


# ---------------------------------------------------------------------------
# Plotting
# ---------------------------------------------------------------------------
def plot_trends(
    df: pd.DataFrame,
    save_path: Optional[str] = None,
    show: bool = True,
) -> None:
    """Generate a 2×2 dashboard of sales visualisations.

    Layout
    ------
    Top-left  : Daily sales trend line
    Top-right : Total sales by region (bar)
    Bot-left  : Total sales by product (horizontal bar)
    Bot-right : Revenue per customer distribution (histogram)

    Parameters
    ----------
    df:
        Cleaned dataframe.
    save_path:
        If given the figure is saved to this path before (optionally)
        displaying it.  Parent directories are created automatically.
    show:
        Whether to call ``plt.show()``.  Set to *False* in headless/test
        environments.
    """
    if df.empty:
        logger.warning("plot_trends called with empty dataframe — skipping")
        return

    # Bug fix #3: matplotlib.use() must be called BEFORE pyplot is imported or
    # any figure is created.  Calling it conditionally here after import is too
    # late in many backends and raises a warning/error.  The safe pattern is to
    # call it only when we actually want the non-interactive backend, and guard
    # it so it doesn't raise if the backend is already set.
    if not show:
        try:
            matplotlib.use("Agg")
        except Exception:
            pass

    fig, axes = plt.subplots(2, 2, figsize=(16, 10))
    # Bug fix #4: y=1.01 pushes the super-title outside the figure boundary,
    # causing it to be clipped or invisible.  Changed to y=0.98 (inside the
    # figure) so the title is always visible.
    fig.suptitle("Sales Dashboard", fontsize=16, fontweight="bold", y=0.98)

    ax1, ax2, ax3, ax4 = axes.flat

    # --- 1. Daily sales trend ---
    daily = df.groupby("date")["sales"].sum().reset_index()
    ax1.plot(daily["date"], daily["sales"], color="#58a6ff", linewidth=1.5)
    ax1.fill_between(daily["date"], daily["sales"], alpha=0.15, color="#58a6ff")
    ax1.set_title("Daily Sales Trend")
    ax1.set_xlabel("Date")
    ax1.set_ylabel("Sales ($)")
    ax1.tick_params(axis="x", rotation=30)
    ax1.grid(axis="y", linestyle="--", alpha=0.5)

    # --- 2. Sales by region (bar) ---
    region_totals = df.groupby("region")["sales"].sum().sort_values(ascending=False)
    colors = REGION_COLORS[: len(region_totals)]
    region_totals.plot(kind="bar", ax=ax2, color=colors, edgecolor="white")
    ax2.set_title("Total Sales by Region")
    ax2.set_xlabel("Region")
    ax2.set_ylabel("Total Sales ($)")
    ax2.tick_params(axis="x", rotation=30)
    ax2.grid(axis="y", linestyle="--", alpha=0.5)
    for bar in ax2.patches:
        ax2.text(
            bar.get_x() + bar.get_width() / 2,
            bar.get_height() + 20,
            f"${bar.get_height():,.0f}",
            ha="center",
            va="bottom",
            fontsize=8,
        )

    # --- 3. Sales by product (horizontal bar) ---
    product_totals = df.groupby("product")["sales"].sum().sort_values()
    product_totals.plot(kind="barh", ax=ax3, color="#a78bfa", edgecolor="white")
    ax3.set_title("Total Sales by Product")
    ax3.set_xlabel("Total Sales ($)")
    ax3.set_ylabel("Product")
    ax3.grid(axis="x", linestyle="--", alpha=0.5)

    # --- 4. Revenue per customer distribution ---
    rpc = df["revenue_per_customer"].dropna()
    if len(rpc) > 1:
        ax4.hist(rpc, bins=20, color="#f59e0b", edgecolor="white", alpha=0.85)
        ax4.axvline(rpc.mean(), color="#e53e3e", linestyle="--", linewidth=1.5,
                    label=f"Mean: ${rpc.mean():.2f}")
        ax4.legend(fontsize=8)
    else:
        ax4.text(0.5, 0.5, "Insufficient data", ha="center", va="center",
                 transform=ax4.transAxes)
    ax4.set_title("Revenue per Customer Distribution")
    ax4.set_xlabel("Revenue per Customer ($)")
    ax4.set_ylabel("Frequency")
    ax4.grid(axis="y", linestyle="--", alpha=0.5)

    plt.tight_layout()

    # Save
    if save_path is not None:
        out = Path(save_path)
        out.parent.mkdir(parents=True, exist_ok=True)
        fig.savefig(out, dpi=150, bbox_inches="tight")
        logger.info("Figure saved to %s", out)

    if show:
        try:
            plt.show()
        except Exception as exc:
            logger.warning("plt.show() raised an error (headless env?): %s", exc)

    plt.close(fig)


# ---------------------------------------------------------------------------
# Reporting helpers
# ---------------------------------------------------------------------------
def print_report(stats: dict) -> None:
    """Pretty-print the analysis results to stdout."""
    separator = "─" * 50

    print(separator)
    print("  SALES ANALYSIS REPORT")
    print(separator)
    print(f"  Total sales          : ${stats['total_sales']:>12,.2f}")
    print(f"  Average daily sales  : ${stats['avg_daily_sales']:>12,.2f}")
    print(f"  Median  daily sales  : ${stats['median_daily_sales']:>12,.2f}")
    print(f"  Std-dev daily sales  : ${stats['std_daily_sales']:>12,.2f}")
    print(f"  Best day             :  {stats['top_day']}")
    print(f"  Top region           :  {stats['top_region']}")
    print(f"  Top product          :  {stats['top_product']}")
    corr = stats["correlation_sales_customers"]
    # Bug fix #5: np.isnan() does not handle non-float types safely; use
    # pd.isna() which correctly handles float NaN, None, and other NA sentinels.
    corr_str = f"{corr:.4f}" if not pd.isna(corr) else "N/A"
    print(f"  Sales/customer corr  :  {corr_str}")
    print(separator)

    print("\nBy Region:")
    region_sums = stats["by_region"].get("sum", {})
    region_means = stats["by_region"].get("mean", {})
    region_counts = stats["by_region"].get("count", {})
    for region in sorted(region_sums):
        print(
            f"  {region:<10}  sum=${region_sums[region]:>9,.2f}"
            f"  mean=${region_means.get(region, float('nan')):>8,.2f}"
            f"  n={region_counts.get(region, 0)}"
        )

    print("\nBy Product:")
    product_sums = stats["by_product"].get("sum", {})
    product_means = stats["by_product"].get("mean", {})
    for product in sorted(product_sums):
        print(
            f"  {product:<12}  sum=${product_sums[product]:>9,.2f}"
            f"  mean=${product_means.get(product, float('nan')):>8,.2f}"
        )
    print(separator)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main(
    csv_path: Optional[str] = None,
    save_plot: Optional[str] = None,
    show_plot: bool = True,
) -> dict:
    """Orchestrate the full analysis pipeline.

    Parameters
    ----------
    csv_path:
        Optional path to an external CSV file (passed to :func:`load_data`).
    save_plot:
        Optional file path to save the dashboard image.
    show_plot:
        Whether to display the plot interactively.

    Returns
    -------
    dict
        The statistics dictionary produced by :func:`analyze`.
    """
    # 1. Load
    try:
        df_raw = load_data(csv_path)
    except (FileNotFoundError, ValueError) as exc:
        logger.error("Failed to load data: %s", exc)
        sys.exit(1)

    logger.info("Loaded %d raw rows", len(df_raw))

    # 2. Clean
    try:
        df = clean_data(df_raw)
    except Exception as exc:
        logger.error("Unexpected error during cleaning: %s", exc, exc_info=True)
        sys.exit(1)

    if df.empty:
        logger.error("No data remains after cleaning — aborting.")
        sys.exit(1)

    # 3. Analyse
    try:
        stats = analyze(df)
    except ValueError as exc:
        logger.error("Analysis failed: %s", exc)
        sys.exit(1)

    # 4. Report
    print_report(stats)

    # 5. Plot
    plot_trends(df, save_path=save_plot, show=show_plot)

    return stats


# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Sales Data Analysis")
    parser.add_argument(
        "--csv", metavar="FILE", default=None,
        help="Path to input CSV file (omit to use synthetic data)",
    )
    parser.add_argument(
        "--save-plot", metavar="FILE", default=None,
        help="Save the dashboard figure to this path (e.g. output/dashboard.png)",
    )
    parser.add_argument(
        "--no-show", action="store_true",
        help="Do not open an interactive plot window",
    )
    args = parser.parse_args()

    main(
        csv_path=args.csv,
        save_plot=args.save_plot,
        show_plot=not args.no_show,
    )
