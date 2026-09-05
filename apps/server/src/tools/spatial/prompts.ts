// +-------------------------------------------------------------------------
//
//   地理智能平台 - 空间工具提示词
//
//   文件:       prompts.ts
//
//   日期:       2026年06月30日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

export const LIST_LAYERS_PROMPT = `用于按需检索平台已注册 GIS 图层。

使用规则：
- 只在用户明确要求图层/边界，或任务必须使用已注册几何做区域统计、裁剪、相交时使用。仅提到杭州或其他城市名、普通天气或纯文字问答不调用。
- 不得因为系统存在杭州行政区划就预取、查询或加载它；它不是默认分析范围。
- 本工具只搜索已注册 PostGIS 图层，不访问外部数据源，也不创建合成几何。
- 没有找到权威边界图层时，说明缺少边界数据或请用户上传/选择；不要用地理编码 bbox 替代。
- sourceType、category、status 只在用户或前序工具结果给出明确过滤条件时使用。
- 命中图层后，必须用 query_layer 和返回的 layerKey 读取真实要素，再进入空间分析。`

export const QUERY_LAYER_PROMPT = `用于从已注册 PostGIS 图层读取真实要素。

使用规则：
- 只在 list_layers 返回所需 layerKey 后使用。
- bbox 只能用于缩小已知查询范围，不能用来创建或替代边界。
- 按名称、编码等已知属性选择要素时，用 propertyFilter 精确筛选；多个目标放入 values，一次查询完成，不要改用地理编码或猜测 bbox。
- 只需要名称、ID 或统计字段时，用 properties 限制返回属性。
- 返回的 feature_collection valueRef 是后续空间分析和气象边界工具的首选输入。
- 不要猜测 layerKey 调用本工具。list_layers 没有命中时，应请求澄清或说明缺少数据并停止。`

export const SPATIAL_ANALYSIS_PROMPT = `用于执行确定性的 GeoJSON 几何运算。

使用规则：
- 输入必须是真实 GeoJSON。前序工具已经返回 valueRef 时直接传 refId；只有用户明确提供的小型几何才传内联对象。
- 路网通行路线用 route_planner；地点解析用 geocode_place；几何距离、面积、包含、缓冲、相交、合并和派生几何用本工具。
- 任务需要行政边界时，不要从地名或地理编码 bbox 伪造 GeoJSON。
- area 接收 FeatureCollection 时同时返回每个要素的 featureAreas；比较多个行政区面积时，先用 query_layer.propertyFilter 一次筛出目标，再按属性读取各自面积。
- 操作要精确选择：area/length/distance 产出标量，buffer/centroid/bbox/destination/midpoint 产出派生几何，intersects/contains/within 判断关系，intersect/union/difference 做面叠加。
- 面向用户总结时保留单位和不确定性。若返回 GeoJSON valueRef，后续工具传 ref，不要复制原始几何。`

export const MAP_EXPORT_PROMPT = `用于把 GeoJSON 结果持久化为可下载 artifact。

使用规则：
- 只有用户要求导出、下载、保存地图数据，或自动化流程明确需要持久化 artifact 时使用。
- geojson 输入必须来自已校验 GeoJSON 或前序工具 valueRef；有 refId 时直接传 refId，不要复制大型几何。
- 本工具只生成 GeoJSON artifact，并让平台地图加载该数据；不会渲染 PNG/JPEG、区县文字标注或静态地图图片。用户要求这些格式时必须说明当前能力缺口并请求改选真实可交付格式。
- filename 只用于展示；不要包含绝对路径、路径穿越或本地文件系统假设。
- 本工具会创建 artifact，应视为有副作用动作。计划模式中只能写入获批计划，不能在只读探索阶段调用。`

export const LAYER_CREATE_PROMPT = `用于从已校验 GeoJSON 创建当前 session/thread 范围内的分析图层。

使用规则：
- 用户希望把派生结果显示为可复用地图图层，或后续查询需要 PostGIS layerKey 时使用。
- geojson 输入必须已经校验或由其他工具产生；前序工具有 valueRef 时直接传 refId，不要用猜测坐标创建行政边界图层。
- name 要简短、可读；description 写事实说明。不要把隐藏状态或长分析文本塞进图层名。
- 返回的 layer 和 feature_collection valueRef 是后续工具的规范句柄；传 ref，不要复制 GeoJSON。`
