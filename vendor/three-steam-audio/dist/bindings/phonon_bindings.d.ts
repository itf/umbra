// Auto-generated from bindings/bindings.h
// Do not edit manually. Run: node scripts/generate-types.ts

export interface SteamAudioBindings extends EmscriptenModule {
  HEAPF32: Float32Array;
  HEAP32: Int32Array;
  HEAPU32: Uint32Array;
  HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(pointer: number): void;
  _sa_context_create(out_ctx: number): number;
  _sa_context_release(ctx: number): void;
  _sa_scene_create(ctx: number, out_scene: number): number;
  _sa_scene_commit(scene: number): void;
  _sa_scene_release(scene: number): void;
  _sa_static_mesh_create(scene: number, num_verts: number, verts: number, num_tris: number, indices: number, num_materials: number, absorption: number, scattering: number, transmission: number, tri_materials: number, out_mesh: number): number;
  _sa_static_mesh_add(mesh: number, scene: number): void;
  _sa_static_mesh_remove(mesh: number, scene: number): void;
  _sa_static_mesh_release(mesh: number): void;
  _sa_instanced_mesh_create(parent_scene: number, sub_scene: number, matrix_4x4: number, out_mesh: number): number;
  _sa_instanced_mesh_update_transform(mesh: number, parent_scene: number, matrix_4x4: number): void;
  _sa_instanced_mesh_remove(mesh: number, parent_scene: number): void;
  _sa_instanced_mesh_release(mesh: number): void;
  _sa_hrtf_create(ctx: number, sample_rate: number, frame_size: number, out_hrtf: number): number;
  _sa_hrtf_create_sofa(ctx: number, sample_rate: number, frame_size: number, sofa_data: number, sofa_size: number, out_hrtf: number): number;
  _sa_hrtf_release(hrtf: number): void;
  _sa_binaural_effect_create(ctx: number, sample_rate: number, frame_size: number, hrtf: number, out_effect: number): number;
  _sa_binaural_effect_release(effect: number): void;
  _sa_binaural_effect_apply(effect: number, hrtf: number, dir_x: number, dir_y: number, dir_z: number, spatial_blend: number, in_buffer: number, out_buffer: number, num_channels: number, num_samples: number): number;
  _sa_direct_effect_create(ctx: number, sample_rate: number, frame_size: number, num_channels: number, out_effect: number): number;
  _sa_direct_effect_release(effect: number): void;
  _sa_direct_effect_apply(effect: number, effect_flags: number, transmission_type: number, distance_attenuation: number, air_absorption: number, directivity: number, occlusion: number, transmission: number, in_buffer: number, out_buffer: number, num_channels: number, num_samples: number): number;
  _sa_reflection_effect_create(ctx: number, sample_rate: number, frame_size: number, num_channels: number, out_effect: number): number;
  _sa_reflection_effect_release(effect: number): void;
  _sa_reflection_effect_apply(effect: number, reverb_times: number, in_buffer: number, out_buffer: number, num_samples: number): number;
  _sa_reflection_effect_get_tail(effect: number, out_buffer: number, num_samples: number): number;
  _sa_simulator_create(ctx: number, scene: number, sample_rate: number, frame_size: number, max_sources: number, max_occlusion_samples: number, reflections_enabled: number, max_rays: number, diffuse_samples: number, max_duration: number, max_order: number, reflection_threads: number, convolution: number, out_sim: number): number;
  _sa_simulator_commit(sim: number): void;
  _sa_simulator_release(sim: number): void;
  _sa_simulator_run_direct(sim: number): number;
  _sa_simulator_run_reflections(sim: number): number;
  _sa_simulator_set_listener(sim: number, x: number, y: number, z: number, ahead_x: number, ahead_y: number, ahead_z: number, up_x: number, up_y: number, up_z: number, reflection_rays: number, reflection_bounces: number, reflection_duration: number, reflection_order: number, irradiance_min_distance: number): void;
  _sa_source_create(sim: number, simulation_flags: number, out_source: number): number;
  _sa_source_release(source: number, sim: number): void;
  _sa_source_set_inputs(source: number, x: number, y: number, z: number, ahead_x: number, ahead_y: number, ahead_z: number, up_x: number, up_y: number, up_z: number, direct_flags: number, distance_model: number, min_distance: number, distance_max: number, distance_samples: number, distance_curve: number, air_model: number, air_coefficients: number, air_max: number, air_samples: number, air_curves: number, dipole_weight: number, dipole_power: number, occlusion_type: number, occlusion_radius: number, occlusion_samples: number, transmission_rays: number, reflections_enabled: number, reverb_scale: number): void;
  _sa_source_set_reflection_inputs(source: number, x: number, y: number, z: number, ahead_x: number, ahead_y: number, ahead_z: number, up_x: number, up_y: number, up_z: number, enabled: number, reverb_scale: number): void;
  _sa_source_get_direct_outputs(source: number, out_distance_att: number, out_air_absorption: number, out_directivity: number, out_occlusion: number, out_transmission: number): number;
  _sa_source_get_reflection_outputs(source: number, out_reverb_times: number): number;
  _sa_source_get_reflection_ir_size(source: number): number;
  _sa_source_get_reflection_ir(source: number, out_floats: number, max_floats: number): number;
  _sa_buffer_alloc(num_floats: number): number;
  _sa_buffer_free(buffer: number): void;
  _sa_buffer_deinterleave(interleaved: number, deinterleaved: number, num_channels: number, num_samples: number): void;
  _sa_buffer_interleave(deinterleaved: number, interleaved: number, num_channels: number, num_samples: number): void;
}

// The default export is an async factory function.
declare function createSteamAudioModule(moduleArg?: Partial<EmscriptenModule>): Promise<SteamAudioBindings>;
export default createSteamAudioModule;
