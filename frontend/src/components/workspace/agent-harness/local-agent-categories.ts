import type { Agent } from "@/core/agents";

export const ALL_LOCAL_AGENT_CATEGORY = "all";

export const LOCAL_AGENT_CATEGORIES = [
  { id: ALL_LOCAL_AGENT_CATEGORY, zhLabel: "全部", enLabel: "All" },
  { id: "customer_insight", zhLabel: "客户洞察", enLabel: "Customer" },
  { id: "industry_market", zhLabel: "行业市场", enLabel: "Market" },
  { id: "product_factory", zhLabel: "产品工厂", enLabel: "Product" },
  { id: "trading_assist", zhLabel: "交易辅助", enLabel: "Trading" },
  { id: "compliance_risk", zhLabel: "合规风控", enLabel: "Risk" },
  { id: "data_analysis", zhLabel: "数据分析", enLabel: "Data" },
  { id: "operations_finance", zhLabel: "运营财务", enLabel: "Operations" },
  { id: "enterprise_office", zhLabel: "企业办公", enLabel: "Office" },
  { id: "other", zhLabel: "其他", enLabel: "Other" },
] as const;

export type LocalAgentCategoryId =
  (typeof LOCAL_AGENT_CATEGORIES)[number]["id"];

type ConcreteCategoryId = Exclude<
  LocalAgentCategoryId,
  typeof ALL_LOCAL_AGENT_CATEGORY
>;

const CATEGORY_KEYWORDS: Record<ConcreteCategoryId, string[]> = {
  customer_insight: [
    "customer",
    "client",
    "crm",
    "profile",
    "insight",
    "客户",
    "客群",
    "画像",
    "洞察",
  ],
  industry_market: [
    "industry",
    "market",
    "trend",
    "research",
    "sector",
    "行业",
    "市场",
    "趋势",
    "研报",
  ],
  product_factory: [
    "product",
    "portfolio",
    "pricing",
    "offer",
    "产品",
    "工厂",
    "组合",
    "定价",
  ],
  trading_assist: [
    "trade",
    "trading",
    "transaction",
    "order",
    "deal",
    "交易",
    "下单",
    "成交",
    "委托",
  ],
  compliance_risk: [
    "compliance",
    "risk",
    "legal",
    "audit",
    "control",
    "合规",
    "风控",
    "风险",
    "审计",
  ],
  data_analysis: [
    "data",
    "analysis",
    "analytics",
    "sql",
    "chart",
    "etl",
    "数据",
    "分析",
    "报表",
  ],
  operations_finance: [
    "operation",
    "ops",
    "finance",
    "budget",
    "cost",
    "运营",
    "财务",
    "经营",
    "预算",
  ],
  enterprise_office: [
    "office",
    "document",
    "meeting",
    "admin",
    "hr",
    "办公",
    "文档",
    "会议",
    "人事",
    "行政",
  ],
  other: [],
};

function searchableAgentText(agent: Agent): string {
  return [
    agent.display_name ?? "",
    agent.name,
    agent.description,
    agent.model ?? "",
    ...(agent.tool_groups ?? []),
    ...(agent.skills ?? []),
  ]
    .join(" ")
    .toLowerCase();
}

export function getLocalAgentCategoryIds(agent: Agent): ConcreteCategoryId[] {
  const explicit = agent.category?.trim();
  if (
    explicit &&
    explicit !== ALL_LOCAL_AGENT_CATEGORY &&
    LOCAL_AGENT_CATEGORIES.some((category) => category.id === explicit)
  ) {
    return [explicit as ConcreteCategoryId];
  }

  const text = searchableAgentText(agent);

  for (const category of LOCAL_AGENT_CATEGORIES) {
    if (category.id === ALL_LOCAL_AGENT_CATEGORY || category.id === "other") {
      continue;
    }
    if (
      CATEGORY_KEYWORDS[category.id].some((keyword) =>
        text.includes(keyword.toLowerCase()),
      )
    ) {
      return [category.id];
    }
  }

  return ["other"];
}

export function localAgentMatchesCategory(
  agent: Agent,
  categoryId: LocalAgentCategoryId,
): boolean {
  return (
    categoryId === ALL_LOCAL_AGENT_CATEGORY ||
    getLocalAgentCategoryIds(agent).includes(categoryId as ConcreteCategoryId)
  );
}

export function getLocalAgentCategoryLabel(
  categoryId: LocalAgentCategoryId,
  locale: string,
): string {
  const category = LOCAL_AGENT_CATEGORIES.find(
    (candidate) => candidate.id === categoryId,
  );
  if (!category) return locale.startsWith("zh") ? "其他" : "Other";
  return locale.startsWith("zh") ? category.zhLabel : category.enLabel;
}
