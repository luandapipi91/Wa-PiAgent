import { test, expect, mock } from "bun:test";
import { render, screen } from "@testing-library/react";

mock.module("../store/session", () => ({
	useSessionStore: Object.assign((sel: any) => sel({}), { getState: () => ({ openFilePreview: () => {} }) }),
}));
mock.module("../store/projects", () => ({
	useProjectsStore: Object.assign((sel: any) => sel({ projects: [] }), { getState: () => ({ projects: [] }) }),
}));
mock.module("../store/toast", () => ({
	useToastStore: Object.assign((sel: any) => sel({}), { getState: () => ({ add: () => {} }) }),
}));
mock.module("../util/clipboard", () => ({ copyToClipboard: async () => {} }));
mock.module("../../element-pick", () => ({
	parseInspectMessage: () => null,
	sendElementToChat: async () => {},
}));
mock.module("../i18n/useTranslation", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
mock.module("./ui/Icon", () => ({ Icon: (p: any) => <svg data-icon={p.name} /> }));
mock.module("./ui/ShareButton", () => ({ ShareResultModal: () => null }));

import { useBrowserStore } from "../../store/browser";
const { BrowserPanel } = await import("../BrowserPanel");

test("dbg: BrowserPanel 内把手 outerHTML", () => {
	useBrowserStore.setState({ open: true, path: "/x/index.html" as any });
	render(<BrowserPanel />);
	const h = screen.getByTestId("browser-url-resize");
	console.log("OUTER:", h.outerHTML.slice(0, 400));
});
