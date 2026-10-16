import type { ReactNode } from "react";
import { Icon } from "./Icon";

export interface AutoWidthSelectOption {
        value: string;
        label: string;
        disabled?: boolean;
}

interface Props {
        /** select 的 data-testid；占位 span 的 testid 自动为 `${testId}-sizer` */
        testId: string;
        ariaLabel: string;
        value: string;
        onChange: (value: string) => void;
        options: AutoWidthSelectOption[];
        disabled?: boolean;
        /** 限宽用 Tailwind 类（必须写完整字面量，否则 Tailwind 扫不到不生成 CSS） */
        maxWidthClass?: string;
}

/**
 * 宽度自适应的下拉选择器。
 *
 * 原生 <select> 的固有宽度按「最宽 option」计算，选项长短不一时会被撑得过宽、
 * 原生箭头随元素右边缘跑到离文字很远的地方；且各平台/浏览器的原生箭头样式不一
 * （与项目 Icon 体系也对不上）。这里：
 *  - 用不可见占位 span 按「当前选中项」文案撑出宽度；
 *  - select 靠 w-0 + min-w-full 不参与列宽固有计算（百分比在 intrinsic sizing 中
 *    按 auto 处理），铺满占位 span 撑出的列宽；
 *  - appearance-none 掉原生箭头，统一改画 Icon chevron-down 贴右对齐。
 *
 * 所有下拉选择器共用本组件，保证箭头外观与文字-箭头间距一致。
 */
export function AutoWidthSelect({
        testId,
        ariaLabel,
        value,
        onChange,
        options,
        disabled,
        maxWidthClass = "max-w-[240px]",
}: Props) {
        const current = options.find((o) => o.value === value);
        const label = current?.label ?? "";
        const selectClass =
                "col-start-1 row-start-1 w-0 min-w-full appearance-none truncate bg-transparent pr-5 text-xs text-secondary outline-none cursor-pointer disabled:cursor-not-allowed";

        return (
                <span
                        className={`relative inline-grid ${maxWidthClass} items-center`}
                >
                        {/* 占位 span 与 select 同一格、同一字体（text-xs），保证撑出的宽度与显示文字一致；
          pr-5 给箭头让位（箭头盒子 1.5em = 18px，不留位会跟文字堆在一起） */}
                        <span
                                aria-hidden
                                data-testid={`${testId}-sizer`}
                                className="invisible col-start-1 row-start-1 min-w-0 truncate pr-5 text-xs text-secondary"
                        >
                                {label}
                        </span>
                        <Select
                                testId={testId}
                                ariaLabel={ariaLabel}
                                value={value}
                                onChange={onChange}
                                options={options}
                                disabled={disabled}
                                className={selectClass}
                        />
                        {/* chevron-down 图形只占 viewBox 宽度的一半（路径 x=6→18），所以 1em 盒子只能画出 ~6px 箭头，
          比原生箭头小一圈；用 1.5em 盒子让可见箭头≈ 9px，描边≈ 1.2px，与原生观感对齐。
          用 em 而非 px，使箭头随设置里的「文字大小」（--font-scale）一起缩放。 */}
                        <Icon
                                name="chevron-down"
                                size="1.5em"
                                className="pointer-events-none col-start-1 row-start-1 self-center justify-self-end text-xs text-tertiary"
                        />
                </span>
        );
}

function Select({
        testId,
        ariaLabel,
        value,
        onChange,
        options,
        disabled,
        className,
}: {
        testId: string;
        ariaLabel: string;
        value: string;
        onChange: (value: string) => void;
        options: AutoWidthSelectOption[];
        disabled?: boolean;
        className: string;
}): ReactNode {
        return (
                <select
                        data-testid={testId}
                        value={value}
                        onChange={(e) => onChange(e.target.value)}
                        disabled={disabled}
                        aria-label={ariaLabel}
                        className={className}
                >
                        {options.map((o) => (
                                <option
                                        key={o.value}
                                        value={o.value}
                                        disabled={o.disabled}
                                >
                                        {o.label}
                                </option>
                        ))}
                </select>
        );
}
