local source = data.raw["radar"] and data.raw["radar"]["radar"]
if not source then
  error("AIRI awareness radar requires the base radar prototype")
end

local radar = table.deepcopy(source)
radar.name = "airi-npc-awareness-radar"
radar.localised_name = {"entity-name.radar"}
radar.flags = {
  "placeable-off-grid",
  "not-on-map",
  "not-deconstructable",
  "not-blueprintable",
  "not-repairable",
  "not-flammable",
  "not-upgradable",
  "not-in-kill-statistics",
}
radar.selectable_in_game = false
radar.allow_copy_paste = false
radar.minable = nil
radar.is_military_target = false
radar.collision_box = {{0, 0}, {0, 0}}
radar.selection_box = {{0, 0}, {0, 0}}
radar.collision_mask = {layers = {}}
radar.energy_source = {type = "void"}
radar.energy_usage = "1W"
radar.energy_per_sector = "1J"
radar.energy_per_nearby_scan = "1J"
radar.max_distance_of_sector_revealed = 0
radar.max_distance_of_nearby_sector_revealed = 1

-- The companion radar is intentionally world-invisible. The base radar stores
-- its rotating dish/shadow in pictures and its ground decal separately as an
-- integration patch, so clear every inherited world visual explicitly.
radar.pictures = nil
radar.frozen_patch = nil
radar.integration_patch = nil
radar.integration_patch_render_layer = nil
radar.water_reflection = nil
radar.graphics_set = nil
radar.rotation_speed = 0
radar.connects_to_other_radars = false

data:extend({radar})

-- The console's Recent activity feed follows new events until the player
-- scrolls it by hand. Factorio exposes neither a scroll offset nor a scroll
-- event to Lua, so the wheel itself is the signal. consuming = "none" leaves the
-- wheel doing everything it normally does (scrolling the feed, zooming the map);
-- these inputs only listen. Players can rebind or clear them under Controls.
data:extend({
  {
    type = "custom-input",
    name = "airi-task-board-activity-scroll-up",
    localised_name = "AIRI console: scroll activity up",
    key_sequence = "mouse-wheel-up",
    consuming = "none",
    action = "lua",
  },
  {
    type = "custom-input",
    name = "airi-task-board-activity-scroll-down",
    localised_name = "AIRI console: scroll activity down",
    key_sequence = "mouse-wheel-down",
    consuming = "none",
    action = "lua",
  },
})
