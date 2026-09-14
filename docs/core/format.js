/**
 * 公用心核 · 格式化工具
 *
 * 这些函数被 tools.js / cards 使用，输出既给模型看（紧凑 JSON），
 * 也给界面看（中文短描述），两端保持一致。
 */

export const money = (value) => {
  if (value === null || value === undefined || value === "") return "-";
  const number = Number(value);
  return Number.isFinite(number) ? `¥${number.toFixed(2)}` : String(value);
};

/** 毫秒时间戳 → 「09-14 17:03」 */
export const fmtTs = (value) => {
  const ts = Number(value);
  if (!Number.isFinite(ts) || ts <= 0) return "";
  const ms = ts < 10_000_000_000 ? ts * 1000 : ts;
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/** 把商品属性拼成「大杯/冰/少少甜/无奶油」 */
export const specOf = (product) => {
  const parts = [];
  for (const group of product?.productAttrs || []) {
    const options = group?.productSubAttrs || [];
    const selected = options.filter((o) => o?.selected).map((o) => o.attributeName);
    const chosen = selected.length ? selected : options.map((o) => o.attributeName);
    parts.push(...chosen.filter(Boolean).map(String));
  }
  return parts.join("/");
};

export const briefStore = (store) => ({
  deptId: store?.deptId,
  deptName: store?.deptName,
  address: store?.address,
  distanceKm: Math.round((Number(store?.distance) || 0) * 100) / 100,
  hours: `${store?.workTimeStart || ""}-${store?.workTimeEnd || ""}`,
  status: store?.workStatus || "",
});

export const briefProduct = (product) => ({
  productId: product?.productId,
  productName: product?.productName,
  skuCode: product?.skuCode,
  spec: specOf(product),
  price: product?.estimatePrice ?? product?.initialPrice,
  initialPrice: product?.initialPrice,
  tags: product?.tags || [],
});

export const previewRows = (preview) => [
  { k: "门店", v: preview.deptName || "" },
  { k: "地址", v: preview.address || "" },
  { k: "预计取餐", v: preview.pickup || "" },
  { k: "面价合计", v: money(preview.initialTotal) },
  { k: "优惠", v: money(preview.privilege) },
  { k: "实付", v: money(preview.payAmount), strong: true },
];

/** 把 previewOrder 的原始响应转成统一结构 */
export const toPreview = (deptId, data) => {
  const shop = data?.shopInfo || {};
  const items = (data?.productInfoList || []).map((item) => ({
    name: item?.name,
    amount: item?.amount,
    spec: item?.additionDesc || "",
    price: item?.estimatePrice,
    total: item?.estimateTotalPrice,
  }));
  const coupons = (data?.couponCodeList || []).filter(Boolean);
  return {
    deptId: shop.deptId ?? deptId,
    deptName: shop.deptName || "",
    address: shop.address || "",
    hours: `${shop.workTimeStart || ""}-${shop.workTimeEnd || ""}`,
    items,
    initialTotal: data?.totalInitialPrice,
    payAmount: data?.discountPrice,
    privilege: data?.privilegeMoney,
    pickup: fmtTs(data?.aboutTime),
    coupons,
  };
};

/** 把 queryOrderDetailInfo 的原始响应转成 rows + items */
export const toOrderRows = (data) => {
  const shop = data?.shopInfo || {};
  const code = data?.takeMealCodeInfo || {};
  const rows = [
    { k: "订单号", v: String(data?.orderId ?? data?.orderIdStr ?? "") },
    { k: "状态", v: data?.orderStatusName || "" },
    { k: "门店", v: shop.deptName || "" },
    { k: "预计取餐", v: fmtTs(data?.aboutTime) },
    { k: "实际取餐", v: data?.takeMealTime || "" },
    { k: "取餐码", v: code.code || "", strong: true },
    { k: "实付", v: money(data?.orderPayAmount) },
  ].filter((row) => row.v !== "" && row.v != null);

  const items = (data?.productInfoList || []).map((item) => ({
    name: item?.name,
    amount: item?.amount,
    spec: item?.additionDesc || "",
  }));

  return { rows, items, status: data?.orderStatusName || "" };
};

/** 把一段很长的工具结果压成一行，给界面用 */
export const short = (text, limit = 200) => {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
};

/** 归一化订单商品参数，避免模型把 productId / skuCode 写错字段名 */
export const normalizeItems = (raw) => {
  const items = [];
  for (const entry of raw || []) {
    if (!entry || typeof entry !== "object") continue;
    const productId = entry.product_id ?? entry.productId;
    const skuCode = String(entry.sku_code ?? entry.skuCode ?? "").trim();
    if (!productId || !skuCode) throw new Error("商品参数不完整：需要 product_id 与 sku_code");
    const amount = Math.max(1, Number.parseInt(entry.amount ?? 1, 10) || 1);
    items.push({ product_id: Number(productId), sku_code: skuCode, amount });
  }
  if (!items.length) throw new Error("商品列表为空");
  return items;
};

/** CLI 需要的 productId:skuCode[:amount] 形式 */
export const itemSpec = (item) => `${item.product_id}:${item.sku_code}:${item.amount ?? 1}`;
