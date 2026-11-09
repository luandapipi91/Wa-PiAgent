import { useTranslation } from "../../i18n/useTranslation";

// 知识库页面壳：本任务只渲染占位标题，列表/索引等由后续任务填充。
export function KnowledgePage() {
  const { t } = useTranslation();
  return <h2>{t("settings.nav.knowledge")}</h2>;
}
