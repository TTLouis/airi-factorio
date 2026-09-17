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

-- These listen-only wheel inputs were introduced to stop Recent activity follow
-- when a player manually scrolls the feed. The control-stage handler assumed a
-- CustomInputEvent exposes the hovered GUI element, but Factorio does not make
-- that relationship available through this event. In 2.0.77 the unsafe handler
-- can be invoked without a usable event payload and crash the whole multiplayer
-- server. Keep the prototypes so existing control-stage registrations and save
-- bindings stay valid, but disable them until the handler is replaced with an
-- event-safe implementation. The LIVE/PAUSED button and hover hold behavior
-- remain available in the console.
data:extend({
  {
    type = "custom-input",
    name = "airi-task-board-activity-scroll-up",
    localised_name = "AIRI console: scroll activity up",
    key_sequence = "mouse-wheel-up",
    consuming = "none",
    action = "lua",
    enabled = false,
  },
  {
    type = "custom-input",
    name = "airi-task-board-activity-scroll-down",
    localised_name = "AIRI console: scroll activity down",
    key_sequence = "mouse-wheel-down",
    consuming = "none",
    action = "lua",
    enabled = false,
  },
})

-- The console's top-left button shows which vendor is behind the model AIRI is
-- currently calling. One sprite per vendor, named after the id the control stage
-- resolves from the configured model identifier. A model that matches no vendor
-- deliberately gets no house avatar: the button answers "which vendor answers",
-- and it keeps its default sprite when there is no answer.
--
-- Factorio's data stage has no file-exists test and a missing sprite file is a
-- hard load failure, so every id listed here must have a committed PNG. The
-- committed files are flat brand-color placeholders; replacing one with the
-- vendor's own 64x64 icon needs no code change. See the folder's README.
local provider_avatars = {}
for _, provider in ipairs({"claude", "openai", "deepseek"}) do
  provider_avatars[#provider_avatars + 1] = {
    type = "sprite",
    name = "airi-provider-" .. provider,
    filename = "__autorio__/graphics/icons/provider/" .. provider .. ".png",
    size = 64,
    scale = 0.5,
    flags = {"gui-icon"},
  }
end

data:extend(provider_avatars)
