import { describe, expect, it } from 'vitest'

import {
  METEOROLOGICAL_DATASET_SUFFIXES,
  METEOROLOGICAL_TOOL_FILE_SUFFIXES,
  METEOROLOGICAL_UPLOAD_SUFFIXES,
} from './meteorology.js'

describe('meteorological file suffix facts', () => {
  it('keeps GRIB2 and every upload suffix in the tool file catalog', () => {
    expect(METEOROLOGICAL_DATASET_SUFFIXES).toContain('.grib2')
    expect(METEOROLOGICAL_UPLOAD_SUFFIXES.every(suffix => METEOROLOGICAL_TOOL_FILE_SUFFIXES.includes(suffix))).toBe(true)
    expect(new Set(METEOROLOGICAL_TOOL_FILE_SUFFIXES).size).toBe(METEOROLOGICAL_TOOL_FILE_SUFFIXES.length)
  })
})
