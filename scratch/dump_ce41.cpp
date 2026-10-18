#include <iostream>
#include <stdlib.h>
#include <lcf/ldb/reader.h>
#include <lcf/rpg/database.h>
#include <lcf/rpg/commonevent.h>

int main() {
    auto db = lcf::LDB_Reader::Load("maps/RPG_RT.ldb", "");
    for (const auto& ce : db->commonevents) {
        if (ce.ID == 41 || ce.ID == 26 || ce.ID == 43 || ce.ID == 289) {
            std::cout << "Common Event ID: " << ce.ID << "\n";
            for (const auto& cmd : ce.event_commands) {
                if (cmd.code == 10810 || cmd.code == 10840 || cmd.code == 10820 || cmd.code == 10830 || cmd.code == 11110) {
                    std::cout << "  Code " << cmd.code << " Params: ";
                    for (int p : cmd.parameters) std::cout << p << " ";
                    std::cout << "\n";
                }
            }
        }
    }
    exit(0);
}
