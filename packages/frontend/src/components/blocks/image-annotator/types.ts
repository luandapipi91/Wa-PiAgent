// 标注数据模型（仅前端内存，不持久化）：坐标为图片自然像素，左上原点。
export type Point = { x: number; y: number };
export type Tool = "arrow" | "rect" | "ellipse" | "text" | "pen" | "eraser";
export type StrokeLevel = "thin" | "medium" | "thick";
export type Shape =
	| { kind: "stroke"; points: Point[]; color: string; width: number }
	| { kind: "arrow"; x1: number; y1: number; x2: number; y2: number; color: string; width: number }
	| { kind: "rect"; x: number; y: number; w: number; h: number; color: string; width: number }
	| { kind: "ellipse"; x: number; y: number; w: number; h: number; color: string; width: number }
	| { kind: "text"; x: number; y: number; text: string; color: string; fontSize: number };
export type AnnotatorAction =
	| { type: "add"; shape: Shape }
	| { type: "erase"; shape: Shape; index: number }
	| { type: "clear"; shapes: Shape[] };
