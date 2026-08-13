export interface AgentGuideQuestion {
  question: string;
  prompt?: string;
}

export const MAX_AGENT_GUIDE_QUESTIONS = 6;

export function validateAgentGuideQuestions(
  questions: AgentGuideQuestion[],
): string | null {
  if (questions.length > MAX_AGENT_GUIDE_QUESTIONS) {
    return `引导问题最多配置 ${MAX_AGENT_GUIDE_QUESTIONS} 条`;
  }
  const emptyIndex = questions.findIndex((item) => !item.question.trim());
  return emptyIndex >= 0
    ? `第 ${emptyIndex + 1} 条引导问题缺少问题文案`
    : null;
}
