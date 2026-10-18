#include <iostream>
#include <algorithm>
#include <vector>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <lcf/lmu/reader.h>
#include <lcf/ldb/reader.h>
#include <lcf/rpg/map.h>
#include <lcf/rpg/database.h>
#include <lcf/rpg/event.h>
#include <lcf/rpg/eventpage.h>
#include <lcf/rpg/eventcommand.h>
#include <lcf/rpg/commonevent.h>
#include "../../ynoengine/src/map_data.h"

bool navigation_passages(const lcf::rpg::Map& map, const lcf::rpg::Chipset& chipset,
        std::vector<unsigned char>& passages) {
    const auto size = static_cast<uint64_t>(map.width) * map.height;
    if (map.width <= 0 || map.height <= 0 || map.generator_flag
            || map.lower_layer.size() != size || map.upper_layer.size() != size) {
        return false;
    }
    passages.clear();
    passages.reserve(size);
    const auto flags = [](const std::vector<uint8_t>& data, int index) {
        return index < static_cast<int>(data.size()) ? data[index] : 0x0f;
    };
    for (size_t i = 0; i < size; ++i) {
        const int upper = map.upper_layer[i] - BLOCK_F;
        const int lower = map.lower_layer[i];
        if (upper < 0 || upper >= BLOCK_F_TILES
                || !((lower >= BLOCK_A && lower < BLOCK_B_END)
                    || (lower >= BLOCK_C && lower < BLOCK_C_END)
                    || (lower >= BLOCK_D && lower < BLOCK_D_END)
                    || (lower >= BLOCK_E && lower < BLOCK_E_END))) {
            return false;
        }
        const int upper_flags = flags(chipset.passable_data_upper, upper);
        int lower_flags = flags(chipset.passable_data_lower, ChipIdToIndex(lower));
        if (lower >= BLOCK_D && lower < BLOCK_D_END && (lower_flags & Passable::Wall)) {
            const int shape = (lower - BLOCK_D) % BLOCK_D_STRIDE;
            if ((shape >= 20 && shape <= 23) || (shape >= 33 && shape <= 37)
                    || shape == 42 || shape == 43 || shape == 45 || shape == 46) {
                lower_flags = 0x0f;
            }
        }
        // shortcut: static tiles only; event pages and changed chipsets need runtime collision feedback.
        passages.push_back((upper_flags & Passable::Above ? upper_flags & lower_flags : upper_flags) & 0x0f);
    }
    return true;
}

void check_commands(const std::vector<lcf::rpg::EventCommand>& commands, int x, int y, std::unordered_map<int, std::vector<lcf::rpg::EventCommand>>& ce_map, bool& first, std::unordered_set<int>& visited_ce) {
    for (const auto& cmd : commands) {
        if (cmd.code == static_cast<int>(lcf::rpg::EventCommand::Code::Teleport) && cmd.parameters.size() >= 3) {
            if (!first) std::cout << ",\n";
            std::cout << "    { \"targetMapId\": " << cmd.parameters[0]
                      << ", \"startX\": " << x
                      << ", \"startY\": " << y
                      << ", \"targetX\": " << cmd.parameters[1]
                      << ", \"targetY\": " << cmd.parameters[2] << " }";
            first = false;
        }
        // CallEvent mode 0 names a common event directly. Modes 1/2 call map
        // events, and modes 3/4 require runtime variables; they cannot be
        // interpreted as literal common-event IDs. 10840 is EnterExitVehicle.
        if (cmd.code == static_cast<int>(lcf::rpg::EventCommand::Code::CallEvent)
                && cmd.parameters.size() >= 3 && cmd.parameters[0] == 0) {
            int ce_id = cmd.parameters[1];
            if (ce_map.count(ce_id) && visited_ce.find(ce_id) == visited_ce.end()) {
                visited_ce.insert(ce_id);
                check_commands(ce_map[ce_id], x, y, ce_map, first, visited_ce);
                visited_ce.erase(ce_id);
            }
        }
    }
}

struct ExitInteraction {
    std::vector<int> target_map_ids;
    bool unsupported = false;
    int direction = -1;
};

ExitInteraction exit_interaction(const std::vector<lcf::rpg::EventCommand>& commands,
        const std::unordered_map<int, std::vector<lcf::rpg::EventCommand>>& common_events,
        std::unordered_set<int>& visited) {
    using Code = lcf::rpg::EventCommand::Code;
    ExitInteraction result;
    struct DirectionGuard { int indent; int direction; };
    std::vector<DirectionGuard> guards;
    bool has_jump = false;
    const auto merge = [&](const ExitInteraction& transfer) {
        result.unsupported = result.unsupported || transfer.unsupported;
        if (transfer.target_map_ids.empty()) return;
        int direction = transfer.direction;
        for (const auto& guard : guards) {
            if (guard.direction < 0 || (direction >= 0 && direction != guard.direction)) {
                result.unsupported = true;
            } else {
                direction = guard.direction;
            }
        }
        if (result.target_map_ids.empty()) result.direction = direction;
        else if (result.direction != direction) result.unsupported = true;
        result.target_map_ids.insert(result.target_map_ids.end(), transfer.target_map_ids.begin(), transfer.target_map_ids.end());
    };
    for (const auto& command : commands) {
        while (!guards.empty() && command.indent <= guards.back().indent) {
            if (command.indent == guards.back().indent && command.code == static_cast<int>(Code::ElseBranch)) {
                guards.back().direction = -1;
                break;
            }
            guards.pop_back();
        }
        if (command.code == static_cast<int>(Code::Teleport)) {
            if (command.parameters.size() < 3 || command.parameters[0] <= 0) {
                result.unsupported = true;
            } else {
                ExitInteraction transfer;
                transfer.target_map_ids.push_back(command.parameters[0]);
                merge(transfer);
            }
        } else if (command.code == static_cast<int>(Code::RecallToLocation)) {
            result.unsupported = true;
        } else if (command.code == static_cast<int>(Code::CallEvent)) {
            if (command.parameters.size() < 3 || command.parameters[0] != 0) {
                result.unsupported = true;
                continue;
            }
            const int id = command.parameters[1];
            const auto event = common_events.find(id);
            if (event == common_events.end() || !visited.insert(id).second) {
                result.unsupported = true;
                continue;
            }
            auto called = exit_interaction(event->second, common_events, visited);
            visited.erase(id);
            merge(called);
        } else if (command.code == static_cast<int>(Code::ConditionalBranch)
                && !command.parameters.empty() && command.parameters[0] == 6) {
            const auto& p = command.parameters;
            const bool player_facing = p.size() >= 6 && p[1] == 10001
                && p[2] >= 0 && p[2] <= 3 && p[3] == 0 && p[4] == 0;
            guards.push_back({command.indent, player_facing ? p[2] : -1});
        } else if (command.code == static_cast<int>(Code::JumpToLabel)) {
            has_jump = true;
        }
    }
    // shortcut: only uniform positive facing guards are inferred; else branches and jumps need reviewed approaches.
    if (has_jump && result.direction >= 0) result.unsupported = true;
    std::sort(result.target_map_ids.begin(), result.target_map_ids.end());
    result.target_map_ids.erase(std::unique(result.target_map_ids.begin(), result.target_map_ids.end()), result.target_map_ids.end());
    return result;
}

void print_exit_interactions(const lcf::rpg::Map& map,
        const std::unordered_map<int, std::vector<lcf::rpg::EventCommand>>& common_events) {
    std::cout << ",\n  \"exitInteractions\": [";
    bool first = true;
    for (const auto& event : map.events) {
        std::vector<ExitInteraction> interactions;
        bool has_transfer = false;
        for (const auto& page : event.pages) {
            std::unordered_set<int> visited;
            interactions.push_back(exit_interaction(page.event_commands, common_events, visited));
            has_transfer = has_transfer || !interactions.back().target_map_ids.empty() || interactions.back().unsupported;
        }
        if (!has_transfer) continue;
        if (!first) std::cout << ',';
        first = false;
        std::cout << "{\"eventId\":" << event.ID << ",\"startX\":" << event.x
                  << ",\"startY\":" << event.y << ",\"pages\":[";
        for (size_t i = 0; i < event.pages.size(); ++i) {
            if (i) std::cout << ',';
            std::cout << "{\"trigger\":" << event.pages[i].trigger
                      << ",\"layer\":" << event.pages[i].layer << ",\"targetMapIds\":[";
            for (size_t j = 0; j < interactions[i].target_map_ids.size(); ++j) {
                if (j) std::cout << ',';
                std::cout << interactions[i].target_map_ids[j];
            }
            std::cout << "],\"unsupported\":" << (interactions[i].unsupported ? "true" : "false");
            if (!interactions[i].unsupported && interactions[i].direction >= 0) {
                std::cout << ",\"direction\":" << interactions[i].direction;
            }
            std::cout << '}';
        }
        std::cout << "]}";
    }
    std::cout << ']';
}

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "Usage: " << argv[0] << " <Map.lmu> [RPG_RT.ldb] [--navigation]" << std::endl;
        return 1;
    }

    const bool navigation = argc == 4 && std::string(argv[3]) == "--navigation";
    if (argc > 4 || (argc == 4 && !navigation)
            || (argc == 3 && std::string(argv[2]) == "--navigation")) {
        std::cerr << "Expected <Map.lmu> [RPG_RT.ldb] [--navigation]" << std::endl;
        return 1;
    }

    std::string filename = argv[1];
    auto map = lcf::LMU_Reader::Load(filename, "");
    if (!map) {
        std::cerr << "Failed to load " << filename << std::endl;
        return 1;
    }

    std::unordered_map<int, std::vector<lcf::rpg::EventCommand>> ce_map;
    std::vector<unsigned char> passages;
    if (argc >= 3) {
        auto db = lcf::LDB_Reader::Load(argv[2], "");
        if (db) {
            for (const auto& ce : db->commonevents) {
                ce_map[ce.ID] = ce.event_commands;
            }
        }
        if (navigation) {
            const lcf::rpg::Chipset* chipset = nullptr;
            if (db) {
                for (const auto& candidate : db->chipsets) {
                    if (candidate.ID == map->chipset_id) chipset = &candidate;
                }
            }
            if (!chipset || !navigation_passages(*map, *chipset, passages)) {
                std::cerr << "Navigation requires a valid database chipset and static map tile layers" << std::endl;
                return 1;
            }
        }
    }

    std::cout << "{\n  \"teleports\": [\n";
    bool first = true;
    for (const auto& ev : map->events) {
        for (const auto& page : ev.pages) {
            if (page.trigger == 3 || page.trigger == 4) continue;
            std::unordered_set<int> visited_ce;
            check_commands(page.event_commands, ev.x, ev.y, ce_map, first, visited_ce);
        }
    }
    std::cout << "\n  ]";
    if (navigation) {
        print_exit_interactions(*map, ce_map);
        const bool loop_horizontal = map->scroll_type == lcf::rpg::Map::ScrollType_horizontal
            || map->scroll_type == lcf::rpg::Map::ScrollType_both;
        const bool loop_vertical = map->scroll_type == lcf::rpg::Map::ScrollType_vertical
            || map->scroll_type == lcf::rpg::Map::ScrollType_both;
        std::cout << ",\n  \"navigation\": {\"width\": " << map->width
                  << ", \"height\": " << map->height
                  << ", \"loopHorizontal\": " << (loop_horizontal ? "true" : "false")
                  << ", \"loopVertical\": " << (loop_vertical ? "true" : "false")
                  << ", \"passages\": [";
        for (size_t i = 0; i < passages.size(); ++i) {
            if (i) std::cout << ',';
            std::cout << static_cast<int>(passages[i]);
        }
        std::cout << "]}";
    }
    std::cout << "\n}\n";
    return 0;
}
