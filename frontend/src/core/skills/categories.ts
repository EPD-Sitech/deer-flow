/**
 * Skill business categories (mirrors the backend definitions in
 * `backend/app/gateway/skills_metadata.py`).
 */
export const SKILL_CATEGORIES = [
  { id: "customer_insight", label: "客户洞察" },
  { id: "industry_market", label: "行业市场" },
  { id: "product_factory", label: "产品工厂" },
  { id: "trading_assist", label: "交易辅助" },
  { id: "compliance_risk", label: "合规风控" },
  { id: "data_analysis", label: "数据分析" },
  { id: "operations_finance", label: "运营财务" },
  { id: "enterprise_office", label: "企业办公" },
  { id: "other", label: "其他" },
] as const;

export function getSkillCategoryLabel(category: string | null | undefined) {
  return SKILL_CATEGORIES.find((item) => item.id === category)?.label ?? "其他";
}
