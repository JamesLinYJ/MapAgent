// +-------------------------------------------------------------------------
//
//   地理智能平台 - 气象文件类型事实
//
//   文件:       meteorology.ts
//
//   日期:       2026年08月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

export const METEOROLOGICAL_DATASET_SUFFIXES = [
  '.nc',
  '.nc4',
  '.tif',
  '.tiff',
  '.grib',
  '.grib2',
  '.grb',
  '.grb2',
  '.h5',
  '.hdf5',
] as const

export const METEOROLOGICAL_RADAR_SUFFIXES = ['.bz2'] as const
export const METEOROLOGICAL_BOUNDARY_SUFFIXES = ['.zip', '.shp', '.geojson', '.json'] as const
export const METEOROLOGICAL_UPLOAD_SUFFIXES = [
  ...METEOROLOGICAL_DATASET_SUFFIXES,
  ...METEOROLOGICAL_RADAR_SUFFIXES,
] as const
export const METEOROLOGICAL_TOOL_FILE_SUFFIXES = [
  ...METEOROLOGICAL_UPLOAD_SUFFIXES,
  ...METEOROLOGICAL_BOUNDARY_SUFFIXES,
] as const
