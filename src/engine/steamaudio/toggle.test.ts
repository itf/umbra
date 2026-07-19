import { describe, it, expect } from 'vitest';
import { selectBackend, selectBackendFromSearch, preferredBackend } from './toggle';

describe('backend selection', () => {
  it('picks steam for engine=steam and engine=steam-sofa', () => {
    expect(selectBackend('steam')).toBe('steam');
    expect(selectBackend('steam-sofa')).toBe('steam'); // SOFA variant also selects steam
  });

  it('defaults to ours for absent / unknown / explicit ours', () => {
    expect(selectBackend(null)).toBe('ours');
    expect(selectBackend(undefined)).toBe('ours');
    expect(selectBackend('ours')).toBe('ours');
    expect(selectBackend('')).toBe('ours');
    expect(selectBackend('STEAM')).toBe('ours'); // case-sensitive, exact match
    expect(selectBackend('something')).toBe('ours');
  });

  it('reads the engine param from a query string', () => {
    expect(selectBackendFromSearch('?engine=steam')).toBe('steam');
    expect(selectBackendFromSearch('?engine=steam&level=clap-maze')).toBe('steam');
    expect(selectBackendFromSearch('?level=clap-maze')).toBe('ours');
    expect(selectBackendFromSearch('')).toBe('ours');
  });

  it('preferredBackend defaults to steam when no engine param is present', () => {
    expect(preferredBackend('')).toBe('steam');
    expect(preferredBackend('?level=clap-maze')).toBe('steam');
  });

  it('preferredBackend lets an explicit engine param override the default', () => {
    expect(preferredBackend('?engine=ours')).toBe('ours');
    expect(preferredBackend('?engine=steam')).toBe('steam');
    expect(preferredBackend('?engine=bogus')).toBe('ours'); // explicit-but-unknown → ours
  });
});
