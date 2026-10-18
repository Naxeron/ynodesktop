#include <iostream>
#include <stdlib.h>
#include <lcf/ldb/reader.h>
#include <lcf/rpg/database.h>
#include <lcf/rpg/commonevent.h>

int main() {
    auto db = lcf::LDB_Reader::Load("maps/RPG_RT.ldb", "");
    if (!db) {
        std::cout << "Failed to load RPG_RT.ldb\n";
        exit(1);
    }
    for (const auto& ce : db->commonevents) {
        for (const auto& cmd : ce.event_commands) {
            if (cmd.code == 10810) {
                if (cmd.parameters.size() >= 1 && cmd.parameters[0] == 7) {
                    std::cout << "Common Event ID: " << ce.ID << " Name: " << ce.name << " teleports to Map 7!\n";
                }
            }
        }
    }
    exit(0);
}
