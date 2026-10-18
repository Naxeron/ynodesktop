#include <iostream>
#include <stdlib.h>
#include <lcf/ldb/reader.h>
#include <lcf/rpg/database.h>
#include <lcf/rpg/commonevent.h>

int main() {
    auto db = lcf::LDB_Reader::Load("maps/RPG_RT.ldb", "");
    for (const auto& ce : db->commonevents) {
        for (const auto& cmd : ce.event_commands) {
            if (cmd.code == 10810) {
                std::cout << "Common Event ID: " << ce.ID << " Name: " << ce.name << " teleports to Map " << cmd.parameters[0] << "\n";
            }
        }
    }
    exit(0);
}
