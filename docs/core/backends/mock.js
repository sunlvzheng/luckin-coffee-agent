/**
 * 后端适配层 · 演示模式（Mock）
 *
 * 用真实抓取到的数据回放整个点单流程，不需要任何 Token / 后端 / 网络。
 * 明确用于「静态站点上的公开演示」：不会下单、不会扣款。
 *
 * 数据说明：
 *   - STORES / CATALOG 中标注 real 的条目来自真实接口抓取；
 *   - 属性变化时真实接口会返回不同的 skuCode，演示模式用确定性后缀模拟。
 */

const STORES = [
  { deptId: 383343, deptName: "王府井喜悦店", address: "东城区霞公府街1号3幢负二层P029号", distance: 0.6889, workTimeStart: "10:00", workTimeEnd: "21:30", workStatus: "营业中", longitude: 116.410561, latitude: 39.909901, number: "(No.11274)" },
  { deptId: 389374, deptName: "东方新天地B1店", address: "东城区长安街1号东方广场新天地商场负一层CC08-1号", distance: 0.7385, workTimeStart: "07:00", workTimeEnd: "21:00", workStatus: "营业中", longitude: 116.412918, latitude: 39.909318, number: "(No.15237)" },
  { deptId: 389372, deptName: "佳苑国际大厦店", address: "东城区王府井大街218-1号北方佳苑饭店一层-01号", distance: 0.8349, workTimeStart: "07:00", workTimeEnd: "20:30", workStatus: "营业中", longitude: 116.413082, latitude: 39.910314, number: "(No.15326)" },
  { deptId: 330416, deptName: "东方新天地1F店", address: "东城区东长安街1号东方新天地一层南1门第五区A503第五街西侧", distance: 0.9371, workTimeStart: "07:00", workTimeEnd: "21:00", workStatus: "营业中", longitude: 116.416254, latitude: 39.909189, number: "(No.6355)" },
  { deptId: 605119, deptName: "北京合景摩方购物中心店", address: "东城区崇文门外大街1号楼负一层B110", distance: 1.0363, workTimeStart: "10:00", workTimeEnd: "21:30", workStatus: "营业中", longitude: 116.41807, latitude: 39.899745, number: "(No.19800)" },
  { deptId: 601719, deptName: "北京市百货大楼店", address: "东城区王府井大街253号二层216号", distance: 1.0866, workTimeStart: "10:00", workTimeEnd: "21:30", workStatus: "营业中", longitude: 116.409791, latitude: 39.913798, number: "(No.18039)" },
  { deptId: 325025, deptName: "崇文新世界百货店", address: "东城区崇文门外大街3号崇文新世界百货一期南门一层", distance: 1.1193, workTimeStart: "10:00", workTimeEnd: "21:30", workStatus: "营业中", longitude: 116.417285, latitude: 39.89758, number: "(No.1842)" },
  { deptId: 380210, deptName: "哈德门广场G层店", address: "东城区崇文门外大街8号哈德门广场负一层G-ZD5号", distance: 1.1631, workTimeStart: "09:30", workTimeEnd: "20:00", workStatus: "营业中", longitude: 116.419715, latitude: 39.89971, number: "(No.9392)" },
];

const CATALOG = [
  {
    productId: 1262, // real
    productName: "生椰拿铁（首创）",
    skuPrefix: "SP2077",
    price: 20,
    picture: "https://img02.luckincoffeecdn.com/group5/M00/B2/CF/Ct1qP2hrsF-AEzVYAAGXq_WH8UM393.png",
    keywords: ["生椰", "拿铁", "椰", "丝绒"],
    tags: ["新品"],
  },
  {
    productId: 5328, // real
    productName: "冰吸生椰拿铁（首创）",
    skuPrefix: "SP3748",
    price: 21,
    picture: "https://img02.luckincoffeecdn.com/commodity-admin/2026/04/12/a32c0a6f0db443f7a65490c34a912a54.png",
    keywords: ["冰吸", "生椰", "拿铁", "椰"],
    tags: ["新品"],
  },
  {
    productId: 5381, // real
    productName: "轻椰茉莉拿铁",
    skuPrefix: "SP3801",
    price: 20,
    picture: "https://img02.luckincoffeecdn.com/commodity-admin/2026/04/12/3dc09068765f4d9d8660a7d556415298.png",
    keywords: ["茉莉", "轻椰", "拿铁", "椰"],
    tags: ["新品"],
  },
  {
    productId: 9001, // 演示占位
    productName: "标准美式",
    skuPrefix: "SP0001",
    price: 15,
    picture: "",
    keywords: ["美式", "冷萃", "浓缩", "咖啡"],
    tags: [],
  },
  {
    productId: 9002, // 演示占位
    productName: "标准拿铁",
    skuPrefix: "SP0002",
    price: 18,
    picture: "",
    keywords: ["拿铁", "牛奶", "热饮"],
    tags: [],
  },
];

const CUP = ["大杯", "超大杯"];
const TEMP = ["冰", "热", "少冰", "去冰"];
const SUGAR = ["不另外加糖", "少少甜", "少甜", "标准甜"];
const CREAM = ["无奶油", "奶油"];

const pick = (words, list, fallback) => list.find((item) => words.some((w) => item.includes(w))) || fallback;

/** 把查询词解析成规格 + 稳定的 skuCode 后缀（真实接口由服务端完成这件事） */
const resolveSpec = (query) => {
  const words = String(query || "").split(/\s+/).filter(Boolean);
  return {
    cup: pick(words, CUP, "大杯"),
    temp: pick(words, TEMP, "冰"),
    sugar: pick(words, SUGAR, "不另外加糖"),
    cream: pick(words, CREAM, "无奶油"),
  };
};

const skuSuffix = (spec) => {
  const text = `${spec.cup}|${spec.temp}|${spec.sugar}|${spec.cream}`;
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.codePointAt(0)) % 100000;
  return String(hash).padStart(5, "0");
};

const toProduct = (entry, spec) => ({
  productId: entry.productId,
  productName: entry.productName,
  skuCode: `${entry.skuPrefix}-${skuSuffix(spec)}`,
  pictureUrl: entry.picture,
  initialPrice: entry.price,
  estimatePrice: entry.price,
  tags: entry.tags,
  fallback: false,
  productAttrs: [
    { attributeId: 64, attributeName: "杯型", productSubAttrs: [{ attributeName: spec.cup, selected: true }] },
    { attributeId: 17, attributeName: "温度", productSubAttrs: [{ attributeName: spec.temp, selected: true }] },
    { attributeId: 18, attributeName: "糖度", productSubAttrs: [{ attributeName: spec.sugar, selected: true }] },
    { attributeId: 16, attributeName: "奶油", productSubAttrs: [{ attributeName: spec.cream, selected: true }] },
  ],
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 造一个明显是演示用的支付链接，避免误以为是真实收银台 */
const demoPayUrl = (orderId) =>
  `https://example.com/luckin-demo-pay?order=${orderId}&note=%E6%BC%94%E7%A4%BA%E9%93%BE%E6%8E%A5%E4%B8%8D%E5%8F%AF%E6%94%AF%E4%BB%98`;

/** 演示用的“支付二维码”占位图：只展示版面，不包含任何可扫码内容 */
const DEMO_QR_SVG =
  "data:image/svg+xml;charset=utf-8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240">
  <rect width="240" height="240" rx="10" fill="#faf8f5" stroke="#ddd6cb" stroke-width="2"/>
  <g fill="#d9d2c7">
    <rect x="24" y="24" width="52" height="52" rx="6"/><rect x="164" y="24" width="52" height="52" rx="6"/>
    <rect x="24" y="164" width="52" height="52" rx="6"/>
    <rect x="96" y="30" width="12" height="12"/><rect x="120" y="54" width="12" height="12"/>
    <rect x="96" y="78" width="12" height="12"/><rect x="144" y="96" width="12" height="12"/>
    <rect x="96" y="120" width="12" height="12"/><rect x="120" y="144" width="12" height="12"/>
    <rect x="96" y="168" width="12" height="12"/><rect x="144" y="192" width="12" height="12"/>
    <rect x="192" y="120" width="12" height="12"/><rect x="168" y="168" width="12" height="12"/>
  </g>
  <rect x="86" y="96" width="68" height="48" rx="8" fill="#f6f4f1" stroke="#ddd6cb"/>
  <text x="120" y="116" text-anchor="middle" font-size="14" fill="#8a8177" font-family="sans-serif">演示模式</text>
  <text x="120" y="134" text-anchor="middle" font-size="11" fill="#a89f93" font-family="sans-serif">真实环境显示二维码</text>
</svg>`,
  );

export const createMockBackend = () => ({
  id: "mock",
  label: "演示模式（内置样例数据）",
  realOrder: false,
  notes: "静态演示：不会调用任何真实接口，不会下单或扣款。",

  async ping() {
    return { ok: true, version: "demo", detail: "内置演示数据" };
  },

  async stores({ latitude, longitude, keyword } = {}) {
    await sleep(240);
    let list = STORES;
    if (keyword) list = list.filter((s) => s.deptName.includes(keyword) || s.address.includes(keyword));
    // 按传入坐标粗略缩放距离，让演示也能“显得”跟着定位走
    const scale =
      Number.isFinite(latitude) && Number.isFinite(longitude)
        ? Math.max(0.4, Math.min(3, Math.abs(latitude - 39.9042) * 8 + Math.abs(longitude - 116.4074) * 8 + 1))
        : 1;
    return list.map((store) => ({ ...store, distance: Math.round(store.distance * scale * 10000) / 10000 }));
  },

  async searchProducts({ query } = {}) {
    await sleep(260);
    const words = String(query || "").split(/\s+/).filter(Boolean);
    const spec = resolveSpec(query);
    const drinkWords = words.filter((w) => !CUP.includes(w) && !TEMP.includes(w) && !SUGAR.includes(w) && !CREAM.includes(w));

    let hits = CATALOG.filter((entry) => entry.keywords.some((k) => drinkWords.some((w) => w.includes(k) || k.includes(w))));
    if (!hits.length) hits = CATALOG.slice(0, 3);

    return hits.slice(0, 4).map((entry) => toProduct(entry, spec));
  },

  async previewOrder({ deptId, items, latitude, longitude } = {}) {
    await sleep(320);
    const store = STORES.find((s) => s.deptId === Number(deptId)) || STORES[0];
    const lastQuery = this._lastQuery || "";
    const spec = resolveSpec(lastQuery);

    let total = 0;
    const productInfoList = [];
    for (const item of items || []) {
      const entry = CATALOG.find((c) => c.productId === Number(item.product_id)) || CATALOG[0];
      const amount = Number(item.amount || 1);
      total += entry.price * amount;
      productInfoList.push({
        productId: entry.productId,
        skuCode: item.sku_code,
        name: entry.productName,
        amount,
        additionDesc: `${spec.cup}/${spec.temp}/${spec.sugar}/${spec.cream}`,
        initPrice: entry.price,
        estimatePrice: entry.price,
        estimateTotalPrice: entry.price * amount,
        bigPicUrl: entry.picture,
        breviaryPicUrl: entry.picture,
      });
    }

    const discount = 0; // 演示环境没有券
    return {
      aboutTime: Date.now() + 15 * 60 * 1000,
      discountPrice: Math.max(0, total - discount),
      privilegeMoney: discount,
      totalInitialPrice: total,
      couponCodeList: [],
      shopInfo: store,
      productInfoList,
      expressExpectTime: null,
    };
  },

  async createOrder({ deptId, items } = {}) {
    await sleep(420);
    const orderId = Date.now();
    const preview = await this.previewOrder({ deptId, items });
    return {
      orderId,
      orderIdStr: String(orderId),
      payOrderUrl: demoPayUrl(orderId),
      payOrderQrCodeUrl: demoPayUrl(orderId),
      discountPrice: preview.discountPrice,
      needPay: true, // 走支付分支以便展示完整版面，但链接/二维码都是演示用的
      description: "演示模式：未产生真实订单",
    };
  },

  async orderDetail({ orderId } = {}) {
    await sleep(280);
    const store = STORES[0];
    return {
      orderId: String(orderId || ""),
      orderStatus: 60,
      orderStatusName: "等待取餐（演示）",
      aboutTime: Date.now(),
      takeMealTime: "",
      orderPayAmount: 20,
      shopInfo: store,
      takeMealCodeInfo: { code: "A128" },
      productInfoList: [{ name: "生椰拿铁（首创）", amount: 1, additionDesc: "大杯/冰/少少甜/无奶油" }],
    };
  },

  async cancelOrder() {
    await sleep(200);
    return { ok: true, message: "演示模式：已模拟取消" };
  },

  /** 演示模式返回一张明确标注的占位二维码 */
  async makeQr() {
    return DEMO_QR_SVG;
  },

  /** 心核会告知最近的搜索词，演示模式下用来让预览的规格与搜索一致 */
  noteQuery(query) {
    this._lastQuery = query;
  },
});
