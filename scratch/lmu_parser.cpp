#include <iostream>
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

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "Usage: " << argv[0] << " <Map.lmu> [RPG_RT.ldb]" << std::endl;
        return 1;
    }

    std::string filename = argv[1];
    auto map = lcf::LMU_Reader::Load(filename, "");
    if (!map) {
        std::cerr << "Failed to load " << filename << std::endl;
        return 1;
    }

    std::unordered_map<int, std::vector<lcf::rpg::EventCommand>> ce_map;
    if (argc >= 3) {
        auto db = lcf::LDB_Reader::Load(argv[2], "");
        if (db) {
            for (const auto& ce : db->commonevents) {
                ce_map[ce.ID] = ce.event_commands;
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
    std::cout << "\n  ]\n}\n";
    return 0;
}
