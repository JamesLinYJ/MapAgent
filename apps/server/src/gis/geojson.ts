// +-------------------------------------------------------------------------
//
//   地理智能平台 - GeoJSON 运行时校验
//
//   文件:       geojson.ts
//
//   日期:       2026年06月15日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------
export type Position = [number, number, ...number[]]
export type Geometry =
    | { type: 'Point'; coordinates: Position }
    | { type: 'MultiPoint'; coordinates: Position[] }
    | { type: 'LineString'; coordinates: Position[] }
    | { type: 'MultiLineString'; coordinates: Position[][] }
    | { type: 'Polygon'; coordinates: Position[][] }
    | { type: 'MultiPolygon'; coordinates: Position[][][] }
    | { type: 'GeometryCollection'; geometries: Geometry[] }
export interface GeoJsonFeature {
    type: 'Feature'
    properties: Record<string, unknown>
    geometry: Geometry
}
export interface GeoJsonFeatureCollection {
    type: 'FeatureCollection'
    features: GeoJsonFeature[]
}
export type GeoJsonEntity = GeoJsonFeatureCollection | GeoJsonFeature
type PointGeometry = Extract<Geometry, { type: 'Point' }>
type LineGeometry = Extract<Geometry, { type: 'LineString' | 'MultiLineString' }>
type PolygonGeometry = Extract<Geometry, { type: 'Polygon' | 'MultiPolygon' }>
export type PointFeature = Omit<GeoJsonFeature, 'geometry'> & { geometry: PointGeometry }
export type LineFeature = Omit<GeoJsonFeature, 'geometry'> & { geometry: LineGeometry }
export type PolygonFeature = Omit<GeoJsonFeature, 'geometry'> & { geometry: PolygonGeometry }
export type PointFeatureCollection = Omit<GeoJsonFeatureCollection, 'features'> & { features: PointFeature[] }
export type PolygonFeatureCollection = Omit<GeoJsonFeatureCollection, 'features'> & { features: PolygonFeature[] }

export function parseGeoJsonEntity(value: unknown, label = 'GeoJSON'): GeoJsonEntity {
    return parseGeoJsonEntityWithCoordinatePolicy(value, label, 'crs84');
}

// 仅供已显式声明源 CRS 的重投影边界使用。普通调用方必须使用
// parseGeoJsonEntity，让所有进入 Turf/PostGIS/地图渲染的坐标先满足
// RFC 7946 的 OGC:CRS84 [经度, 纬度] 契约。
export function parseProjectedGeoJsonEntity(value: unknown, label = 'GeoJSON'): GeoJsonEntity {
    return parseGeoJsonEntityWithCoordinatePolicy(value, label, 'projected');
}

type CoordinatePolicy = 'crs84' | 'projected'

function parseGeoJsonEntityWithCoordinatePolicy(
    value: unknown,
    label: string,
    coordinatePolicy: CoordinatePolicy,
): GeoJsonEntity {
    if (!isRecord(value) || typeof value.type !== 'string') {
        throw new Error(`${label} 必须是 FeatureCollection、Feature 或 Geometry`);
    }
    if (value.type === 'FeatureCollection') {
        if (!Array.isArray(value.features))
            throw new Error(`${label}.features 必须是数组`);
        return {
            type: 'FeatureCollection',
            features: value.features.map((item, index) => parseFeature(item, `${label}.features[${index}]`, coordinatePolicy)),
        };
    }
    if (value.type === 'Feature')
        return parseFeature(value, label, coordinatePolicy);
    return featureFromGeometry(parseGeometry(value, label, coordinatePolicy));
}
export function toFeatureCollection(entity: GeoJsonEntity): GeoJsonFeatureCollection {
    return entity.type === 'FeatureCollection'
        ? entity
        : { type: 'FeatureCollection', features: [entity] };
}
export function requireSingleFeature(entity: GeoJsonEntity, label: string): GeoJsonFeature {
    if (entity.type === 'Feature')
        return entity;
    if (entity.features.length !== 1) {
        throw new Error(`${label} 必须是单个 Feature，当前包含 ${entity.features.length} 个要素`);
    }
    const feature = entity.features[0];
    if (!feature) throw new Error(`${label} 缺少 Feature`);
    return feature;
}
export function requirePointFeature(entity: GeoJsonEntity, label: string): PointFeature {
    const feature = requireSingleFeature(entity, label);
    if (feature.geometry.type === 'Point')
        return feature as PointFeature;
    if (feature.geometry.type === 'MultiPoint' && feature.geometry.coordinates.length === 1) {
        const position = feature.geometry.coordinates[0];
        if (!position) throw new Error(`${label} 必须包含 Point 坐标`);
        return featureFromGeometry({ type: 'Point', coordinates: position }, feature.properties) as PointFeature;
    }
    throw new Error(`${label} 必须是 Point；实际为 ${feature.geometry.type}`);
}
export function requireLineFeature(entity: GeoJsonEntity, label: string, allowMulti = true): LineFeature {
    const feature = requireSingleFeature(entity, label);
    if (feature.geometry.type === 'LineString')
        return feature as LineFeature;
    if (allowMulti && feature.geometry.type === 'MultiLineString')
        return feature as LineFeature;
    throw new Error(`${label} 必须是 ${allowMulti ? 'LineString 或 MultiLineString' : 'LineString'}；实际为 ${feature.geometry.type}`);
}
export function requirePolygonFeature(entity: GeoJsonEntity, label: string): PolygonFeature {
    const feature = requireSingleFeature(entity, label);
    if (feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon') {
        return feature as PolygonFeature;
    }
    throw new Error(`${label} 必须是 Polygon 或 MultiPolygon；实际为 ${feature.geometry.type}`);
}
export function requirePointCollection(entity: GeoJsonEntity, label: string): PointFeatureCollection {
    const collection = toFeatureCollection(entity);
    if (collection.features.some(feature => feature.geometry.type !== 'Point')) {
        throw new Error(`${label} 只能包含 Point`);
    }
    return collection as PointFeatureCollection;
}
export function requirePolygonCollection(entity: GeoJsonEntity, label: string): PolygonFeatureCollection {
    const collection = toFeatureCollection(entity);
    if (collection.features.some(feature => feature.geometry.type !== 'Polygon' && feature.geometry.type !== 'MultiPolygon')) {
        throw new Error(`${label} 只能包含 Polygon 或 MultiPolygon`);
    }
    return collection as PolygonFeatureCollection;
}
export function combinePolygonFeatures(first: GeoJsonFeature, second: GeoJsonFeature): GeoJsonFeatureCollection {
    return { type: 'FeatureCollection', features: [first, second] };
}
function featureFromGeometry(geometry: Geometry, properties: Record<string, unknown> = {}): GeoJsonFeature {
    return { type: 'Feature', properties: properties ?? {}, geometry };
}
function parseFeature(value: unknown, label: string, coordinatePolicy: CoordinatePolicy): GeoJsonFeature {
    if (!isRecord(value) || value.type !== 'Feature')
        throw new Error(`${label} 必须是 Feature`);
    const properties = value.properties === null || value.properties === undefined
        ? {}
        : isRecord(value.properties) ? value.properties : invalid(`${label}.properties 必须是对象或 null`);
    return featureFromGeometry(parseGeometry(value.geometry, `${label}.geometry`, coordinatePolicy), properties);
}
function parseGeometry(value: unknown, label: string, coordinatePolicy: CoordinatePolicy): Geometry {
    if (!isRecord(value) || typeof value.type !== 'string')
        throw new Error(`${label} 必须是 Geometry`);
    switch (value.type) {
        case 'Point':
            return { type: 'Point', coordinates: parsePosition(value.coordinates, `${label}.coordinates`, coordinatePolicy) };
        case 'MultiPoint':
            return { type: 'MultiPoint', coordinates: parsePositions(value.coordinates, `${label}.coordinates`, 1, coordinatePolicy) };
        case 'LineString':
            return { type: 'LineString', coordinates: parsePositions(value.coordinates, `${label}.coordinates`, 2, coordinatePolicy) };
        case 'MultiLineString':
            return { type: 'MultiLineString', coordinates: parseNestedPositions(value.coordinates, `${label}.coordinates`, 2, 1, coordinatePolicy) };
        case 'Polygon':
            return { type: 'Polygon', coordinates: parsePolygonCoordinates(value.coordinates, `${label}.coordinates`, coordinatePolicy) };
        case 'MultiPolygon':
            return {
                type: 'MultiPolygon',
                coordinates: parseMultiPolygonCoordinates(value.coordinates, `${label}.coordinates`, coordinatePolicy),
            };
        case 'GeometryCollection':
            if (!Array.isArray(value.geometries))
                throw new Error(`${label}.geometries 必须是数组`);
            return {
                type: 'GeometryCollection',
                geometries: value.geometries.map((item, index) => parseGeometry(item, `${label}.geometries[${index}]`, coordinatePolicy)),
            };
        default:
            throw new Error(`${label} 使用了不支持的几何类型：${value.type}`);
    }
}
function parsePosition(value: unknown, label: string, coordinatePolicy: CoordinatePolicy): Position {
    if (!Array.isArray(value) || value.length < 2 || value.some(item => typeof item !== 'number' || !Number.isFinite(item))) {
        throw new Error(`${label} 必须是至少包含两个有限数字的坐标`);
    }
    const [x, y, ...rest] = value;
    if (coordinatePolicy === 'crs84' && (x < -180 || x > 180 || y < -90 || y > 90)) {
        throw new Error(
            `${label} 必须按 OGC:CRS84 的 [经度, 纬度] 轴序取值（经度 -180..180，纬度 -90..90）；投影坐标必须显式声明 CRS`,
        );
    }
    return [x, y, ...rest];
}
function parsePositions(value: unknown, label: string, minimum: number, coordinatePolicy: CoordinatePolicy): Position[] {
    if (!Array.isArray(value) || value.length < minimum)
        throw new Error(`${label} 至少需要 ${minimum} 个坐标`);
    return value.map((item, index) => parsePosition(item, `${label}[${index}]`, coordinatePolicy));
}
function parseNestedPositions(
    value: unknown,
    label: string,
    minimumPositions: number,
    minimumGroups: number,
    coordinatePolicy: CoordinatePolicy,
): Position[][] {
    if (!Array.isArray(value) || value.length < minimumGroups)
        throw new Error(`${label} 至少需要 ${minimumGroups} 组坐标`);
    return value.map((item, index) => parsePositions(item, `${label}[${index}]`, minimumPositions, coordinatePolicy));
}
function parsePolygonCoordinates(value: unknown, label: string, coordinatePolicy: CoordinatePolicy): Position[][] {
    const rings = parseNestedPositions(value, label, 4, 1, coordinatePolicy);
    rings.forEach((ring, index) => {
        const first = ring[0];
        const last = ring.at(-1);
        if (!first || !last || !samePosition(first, last))
            throw new Error(`${label}[${index}] 必须闭合`);
    });
    return rings;
}
function parseMultiPolygonCoordinates(value: unknown, label: string, coordinatePolicy: CoordinatePolicy): Position[][][] {
    if (!Array.isArray(value) || value.length < 1)
        throw new Error(`${label} 至少需要一个 Polygon`);
    return value.map((item, index) => parsePolygonCoordinates(item, `${label}[${index}]`, coordinatePolicy));
}
function samePosition(left: Position, right: Position): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
function invalid(message: string): never {
    throw new Error(message);
}
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
