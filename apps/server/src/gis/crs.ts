// +-------------------------------------------------------------------------
//
//   地理智能平台 - CRS 与投影工具
//
//   文件:       crs.ts
//
//   日期:       2026年06月05日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------
import proj4 from 'proj4';
import type { Geometry } from './geojson.js';

export const GEOJSON_CRS84 = 'OGC:CRS84' as const;
export type GeometryTransformer = <T extends Geometry>(geometry: T) => T;

export function normalizeCrsIdentifier(value: unknown, label = 'CRS'): string {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0)
        return normalizeEpsgCode(value, label);
    if (typeof value !== 'string' || !value.trim())
        throw new Error(`${label} 必须是明确的 CRS 标识，例如 EPSG:3857`);
    const normalized = value.trim().toUpperCase().replace(/\s+/gu, '');
    if (
        ['OGC:CRS84', 'CRS:84', 'CRS84', 'EPSG:4326'].includes(normalized)
        || /^URN:OGC:DEF:CRS:OGC(?::[^:]*)?:CRS84$/u.test(normalized)
        || /^HTTPS?:\/\/WWW\.OPENGIS\.NET\/DEF\/CRS\/OGC\/[^/]+\/CRS84$/u.test(normalized)
    )
        return GEOJSON_CRS84;
    if (normalized === 'EPSG:900913') return 'EPSG:3857';
    const epsg = /^(?:EPSG:|URN:OGC:DEF:CRS:EPSG(?::[^:]*)?:|HTTPS?:\/\/WWW\.OPENGIS\.NET\/DEF\/CRS\/EPSG\/[^/]+\/)(\d+)$/u.exec(normalized);
    if (!epsg?.[1]) throw new Error(`${label} 不支持 '${value}'；必须使用 OGC:CRS84 或明确的 EPSG 代码`);
    return normalizeEpsgCode(Number(epsg[1]), label);
}

function normalizeEpsgCode(code: number, label: string): string {
    if (!Number.isInteger(code) || code <= 0) throw new Error(`${label} EPSG 代码非法：${code}`);
    if (code === 4326) return GEOJSON_CRS84;
    if (code === 900913) return 'EPSG:3857';
    return `EPSG:${code}`;
}

// 同一批几何共享一个 proj4 converter，避免在每个坐标或每个
// Feature 上重复解析投影定义。
export function createGeometryTransformer(
    sourceCrs: string | number,
    targetCrs: string | number,
): GeometryTransformer {
    const normalizedSource = normalizeCrsIdentifier(sourceCrs, '源 CRS');
    const normalizedTarget = normalizeCrsIdentifier(targetCrs, '目标 CRS');
    if (normalizedSource === normalizedTarget) return geometry => geometry;
    const fromProj = proj4Definition(normalizedSource);
    const toProj = proj4Definition(normalizedTarget);
    const converter = proj4(fromProj, toProj);

    function projectPosition(x: number, y: number): [number, number] {
        validateCoordinateDomain(x, y, normalizedSource, '源坐标');
        const projected = converter.forward([x, y]);
        const projectedX = projected[0];
        const projectedY = projected[1];
        if (!Number.isFinite(projectedX) || !Number.isFinite(projectedY)) {
            throw new Error(`坐标从 ${normalizedSource} 重投影到 ${normalizedTarget} 后不是有限数字`);
        }
        validateCoordinateDomain(projectedX!, projectedY!, normalizedTarget, '目标坐标');
        return [projectedX!, projectedY!];
    }

    function convert(coords: unknown): unknown {
        if (typeof coords === 'number')
            return coords;
        if (!Array.isArray(coords))
            return coords;
        if (coords.length === 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
            return projectPosition(coords[0], coords[1]);
        }
        if (coords.length > 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
            const projected = projectPosition(coords[0], coords[1]);
            return [projected[0], projected[1], ...coords.slice(2)];
        }
        return coords.map(convert);
    }

    const transform: GeometryTransformer = <T extends Geometry>(geometry: T): T => {
        if (geometry.type === 'GeometryCollection') {
            return {
                ...geometry,
                geometries: geometry.geometries.map(child => transform(child)),
            } as T;
        }
        return { ...geometry, coordinates: convert(geometry.coordinates) } as T;
    };
    return transform;
}

function validateCoordinateDomain(x: number, y: number, crs: string, label: string): void {
    if (crs === GEOJSON_CRS84) {
        if (x < -180 || x > 180 || y < -90 || y > 90) {
            throw new Error(`${label} 超出 OGC:CRS84 [经度, 纬度] 范围`);
        }
        return;
    }
    if (crs !== 'EPSG:3857') return;
    const halfWorld = 20_037_508.342789244;
    if (Math.abs(x) > halfWorld || Math.abs(y) > halfWorld) {
        throw new Error(`${label} 超出 EPSG:3857 有效范围 ±${halfWorld}`);
    }
}

function proj4Definition(crs: string): string {
    if (crs === GEOJSON_CRS84) return 'EPSG:4326';
    if (crs === 'EPSG:3857') return crs;
    const utm = /^EPSG:(326|327)(\d{2})$/u.exec(crs);
    if (utm?.[1] && utm[2]) {
        const zone = Number(utm[2]);
        if (zone < 1 || zone > 60) throw new Error(`CRS '${crs}' 的 UTM 分区无效`);
        return `+proj=utm +zone=${zone}${utm[1] === '327' ? ' +south' : ''} +datum=WGS84 +units=m +no_defs +type=crs`;
    }
    if (!proj4.defs(crs)) throw new Error(`CRS '${crs}' 未在投影引擎中注册，无法可靠重投影`);
    return crs;
}
