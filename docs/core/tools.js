/**
 * 公用心核 · 工具集
 *
 * 工具只依赖一个 backend 适配器，因此「演示 / 桥接服务 / 本地 CLI」三种后端共用同一套逻辑。
 * 敏感工具（下单、取消）不会直接执行，而是先生成确认卡片交给界面。
 */

import {
  briefProduct,
  briefStore,
  money,
  normalizeItems,
  previewRows,
  short,
  toOrderRows,
  toPreview,
} from "./format.js";

export const SENSITIVE_TOOLS = new Set(["create_order", "cancel_order"]);

export const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: "set_location",
      description: "保存用户的定位坐标，之后找门店都会用它。用户给出位置（例如“我在望京”“用我的定位”）时调用。",
      parameters: {
        type: "object",
        properties: {
          latitude: { type: "number", description: "纬度，例如 39.9042" },
          longitude: { type: "number", description: "经度，例如 116.4074" },
        },
        required: ["latitude", "longitude"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_stores",
      description: "查询附近的瑞幸门店（按距离排序，最多 8 家）。若尚未设置定位会返回错误，此时应先请用户提供位置。",
      parameters: {
        type: "object",
        properties: {
          keyword: { type: "string", description: "门店名称关键词，可省略，例如“东方新天地”" },
          latitude: { type: "number", description: "临时指定纬度，一般省略" },
          longitude: { type: "number", description: "临时指定经度，一般省略" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_products",
      description:
        "在指定门店搜索饮品/商品。query 直接用用户的自然语言，并且必须把规格词原样带上，" +
        "例如“生椰拿铁 冰 少少甜 大杯”。返回结果里的 skuCode 已经按这些规格解析好，" +
        "下单时必须原样使用，禁止修改。",
      parameters: {
        type: "object",
        properties: {
          dept_id: { type: "integer", description: "门店 ID（来自 find_stores）" },
          query: { type: "string", description: "用户原始查询 + 规格词" },
        },
        required: ["dept_id", "query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "preview_order",
      description:
        "订单预览：返回门店、商品明细、预计取餐时间、可用优惠券和实付金额。" +
        "正式下单前必须先调用它，并把实付金额告诉用户。",
      parameters: {
        type: "object",
        properties: {
          dept_id: { type: "integer", description: "门店 ID" },
          items: {
            type: "array",
            description: "商品列表",
            items: {
              type: "object",
              properties: {
                product_id: { type: "integer", description: "商品 ID" },
                sku_code: { type: "string", description: "来自 search_products，原样使用" },
                amount: { type: "integer", description: "数量，默认 1" },
              },
              required: ["product_id", "sku_code"],
            },
          },
        },
        required: ["dept_id", "items"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_order",
      description:
        "正式提交订单（会真实扣款）。调用后界面会弹出确认卡片让用户点确认，你不需要再口头询问一次。",
      parameters: {
        type: "object",
        properties: {
          dept_id: { type: "integer", description: "门店 ID" },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                product_id: { type: "integer" },
                sku_code: { type: "string" },
                amount: { type: "integer" },
              },
              required: ["product_id", "sku_code"],
            },
          },
          coupon_codes: {
            type: "array",
            description: "优惠券编码，来自 preview_order 的 coupons 字段；省略则自动使用预览到的券",
            items: { type: "string" },
          },
        },
        required: ["dept_id", "items"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_order",
      description: "查询订单详情：状态、取餐码、门店、金额等。用户问“好了没”“取餐码多少”时调用。",
      parameters: {
        type: "object",
        properties: { order_id: { type: "string", description: "订单 ID" } },
        required: ["order_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_order",
      description: "取消订单（会真实生效）。调用后界面会弹出确认卡片。",
      parameters: {
        type: "object",
        properties: { order_id: { type: "string", description: "订单 ID" } },
        required: ["order_id"],
      },
    },
  },
];

/** 统一的工具返回结构 */
const outcome = (ok, summary, { cards = [], display = "" } = {}) => ({
  ok,
  summary: typeof summary === "string" ? summary : JSON.stringify(summary),
  cards,
  display,
});

export class ToolRunner {
  constructor(backend) {
    this.backend = backend;
  }

  async execute(session, name, args = {}) {
    const handler = this[`_t_${name}`];
    if (typeof handler !== "function") return outcome(false, `未知工具：${name}`);
    return handler.call(this, session, args);
  }

  // ------------------------------------------------------------------ //
  // 普通工具
  // ------------------------------------------------------------------ //
  async _t_set_location(session, args) {
    const lat = Number(args.latitude);
    const lng = Number(args.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return outcome(false, "经纬度无效，请提供数字坐标");
    }
    session.lat = lat;
    session.lng = lng;
    return outcome(true, { ok: true, lat, lng }, { display: `已保存定位 ${lat.toFixed(5)}, ${lng.toFixed(5)}` });
  }

  async _t_find_stores(session, args) {
    const lat = args.latitude ?? session.lat;
    const lng = args.longitude ?? session.lng;
    if (lat == null || lng == null) {
      return outcome(
        false,
        "尚未设置定位。请询问用户所在位置（或让用户在页面点“定位”），拿到坐标后再调用 set_location。",
      );
    }

    const stores = (await this.backend.stores({
      latitude: Number(lat),
      longitude: Number(lng),
      keyword: (args.keyword || "").trim() || undefined,
    })) || [];

    if (!stores.length) return outcome(true, { count: 0, stores: [] });

    const top = stores.slice(0, 8);
    session.storeCandidates = Object.fromEntries(
      top.filter((s) => s.deptId != null).map((s) => [Number(s.deptId), s]),
    );

    const brief = top.map(briefStore);
    return outcome(true, { count: brief.length, stores: brief }, {
      display: `找到 ${brief.length} 家门店`,
      cards: [
        {
          type: "stores",
          items: brief.map((store) => ({
            deptId: store.deptId,
            name: store.deptName,
            address: store.address,
            distance: `${store.distanceKm} km`,
            hours: store.hours,
            status: store.status,
          })),
        },
      ],
    });
  }

  async _t_search_products(session, args) {
    const deptId = Number(args.dept_id);
    if (!Number.isFinite(deptId)) return outcome(false, "dept_id 无效，请先用 find_stores 获取门店 ID");
    const query = String(args.query || "").trim();
    if (!query) return outcome(false, "query 不能为空");

    // 让后端记住查询词（演示模式下预览的规格要跟着走）
    await this.backend.noteQuery?.(query, { deptId });

    const products = (await this.backend.searchProducts({ deptId, query })) || [];
    if (!products.length) {
      return outcome(true, { deptId, count: 0, products: [] }, {
        display: `没搜到「${query}」，换个说法试试`,
      });
    }

    const candidate = session.storeCandidates?.[deptId];
    session.store = candidate
      ? { deptId, name: candidate.deptName }
      : session.store || { deptId, name: `门店 ${deptId}` };

    const top = products.slice(0, 6);
    const brief = top.map(briefProduct);
    return outcome(true, { deptId, count: brief.length, products: brief }, {
      display: `匹配到 ${brief.length} 个商品`,
      cards: [
        {
          type: "products",
          items: top.map((product, index) => ({
            productId: brief[index].productId,
            name: brief[index].productName,
            skuCode: brief[index].skuCode,
            spec: brief[index].spec,
            price: money(brief[index].price),
            picture: product.pictureUrl || "",
            tags: brief[index].tags,
          })),
        },
      ],
    });
  }

  async _t_preview_order(session, args) {
    const deptId = Number(args.dept_id);
    const items = normalizeItems(args.items);
    const data = await this.backend.previewOrder({ deptId, items });
    const preview = toPreview(deptId, data);

    session.lastPreview = { deptId, items, preview };
    return outcome(true, preview, {
      display: `实付 ${money(preview.payAmount)}，预计取餐 ${preview.pickup || "-"}`,
      cards: [{ type: "summary", title: "订单预览", rows: previewRows(preview), items: preview.items }],
    });
  }

  async _t_get_order(session, args) {
    const orderId = String(args.order_id || "").trim();
    if (!orderId) return outcome(false, "order_id 不能为空");
    const data = await this.backend.orderDetail({ orderId });
    const { rows, items, status } = toOrderRows(data);
    return outcome(
      true,
      {
        orderId,
        status,
        pickupCode: rows.find((row) => row.k === "取餐码")?.v || "",
        payAmount: data?.orderPayAmount,
        items,
      },
      {
        display: `状态：${status || "未知"}`,
        cards: [{ type: "summary", title: `订单 ${orderId}`, rows, items }],
      },
    );
  }

  // ------------------------------------------------------------------ //
  // 敏感工具：先生成确认卡片，用户确认后才执行
  // ------------------------------------------------------------------ //
  async prepareConfirmation(session, name, args = {}) {
    if (name === "create_order") {
      const deptId = Number(args.dept_id);
      const items = normalizeItems(args.items);
      // 一定要重新试算：保证金额、取餐时间和可用优惠券都是最新的
      const data = await this.backend.previewOrder({ deptId, items });
      const preview = toPreview(deptId, data);
      session.lastPreview = { deptId, items, preview };
      return {
        action: "create_order",
        title: "确认下单",
        note: this.backend.realOrder
          ? "确认后将立即向门店提交订单并生成支付链接"
          : "演示模式：确认后只会模拟一次下单，不会扣款",
        rows: previewRows(preview),
        items: preview.items,
        payAmount: preview.payAmount,
        couponCodes: preview.coupons,
        arguments: { dept_id: deptId, items },
      };
    }

    if (name === "cancel_order") {
      const orderId = String(args.order_id || "").trim();
      const data = await this.backend.orderDetail({ orderId });
      const { rows, items } = toOrderRows(data);
      return {
        action: "cancel_order",
        title: "确认取消订单",
        note: "取消后不可恢复；已支付的订单退款规则以瑞幸为准",
        rows,
        items,
        arguments: { order_id: orderId },
      };
    }

    throw new Error(`不支持的确认操作：${name}`);
  }

  async executeConfirmed(session, name, args = {}, payload = {}) {
    if (name === "create_order") {
      if (session.lat == null || session.lng == null) {
        return outcome(false, "缺少定位，无法下单。请先设置位置。");
      }

      const deptId = Number(args.dept_id);
      const items = normalizeItems(args.items);
      const coupons = args.coupon_codes || payload.couponCodes || [];
      const data = await this.backend.createOrder({
        deptId,
        items,
        latitude: session.lat,
        longitude: session.lng,
        coupons,
      });

      const orderId = String(data?.orderId ?? data?.orderIdStr ?? "");
      const payUrl = String(data?.payOrderUrl || "");
      const payQrUrl = String(data?.payOrderQrCodeUrl || "");
      const needPay = data?.needPay !== false;
      const amount = data?.discountPrice;

      let qrSvg = null;
      if (needPay) {
        qrSvg = await this.backend.makeQr(payQrUrl || payUrl).catch(() => null);
      }

      session.lastOrderId = orderId || null;

      return outcome(
        true,
        {
          ok: true,
          orderId,
          needPay,
          payAmount: amount,
          tip: needPay ? "支付二维码已在界面显示，请提醒用户扫码支付" : "无需支付，等待取餐即可",
        },
        {
          display: `订单已提交，实付 ${money(amount)}` + (needPay ? "，待支付" : "，无需支付"),
          cards: [
            {
              type: "payment",
              orderId,
              amount: money(amount),
              needPay,
              payUrl,
              payQrUrl,
              qrSvg,
              demo: !this.backend.realOrder,
              rows: [
                { k: "订单号", v: orderId },
                { k: "实付", v: money(amount), strong: true },
                { k: "门店", v: session.store?.name || "" },
                { k: "预计取餐", v: session.lastPreview?.preview?.pickup || "" },
              ].filter((row) => row.v),
            },
          ],
        },
      );
    }

    if (name === "cancel_order") {
      const orderId = String(args.order_id || "").trim();
      const result = await this.backend.cancelOrder({ orderId });
      const ok = Boolean(result?.ok);
      const message = result?.message || "";
      return outcome(
        ok,
        { ok, orderId, message },
        {
          display: ok ? "订单已取消" : `取消失败：${message}`,
          cards: [{ type: "notice", text: `订单 ${orderId} ` + (ok ? "已取消" : `取消失败：${message}`) }],
        },
      );
    }

    return outcome(false, `不支持的确认操作：${name}`);
  }
}

export { short };
