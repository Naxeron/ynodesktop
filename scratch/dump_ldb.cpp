#include <iostream>
#include <vector>
#include <string>
#include <lcf/ldb/reader.h>
#include <lcf/rpg/database.h>
#include <lcf/rpg/commonevent.h>
#include <lcf/rpg/eventcommand.h>

int main(int argc, char** argv) {
    if (argc < 2) return 1;
    auto db = lcf::LDB_Reader::Load(argv[1], "");
    if (!db) return 1;
    for (const auto& ce : db->commonevents) {
        std::cout << "Common Event " << ce.ID << " (" << ce.name << "):\n";
        for (const auto& cmd : ce.event_commands) {
            if (cmd.code == 10810) {
                std::cout << "  Code " << cmd.code << " Params:";
                for (auto p : cmd.parameters) std::cout << " " << p;
                std::cout << "\n";
            }
        }
    }
    return 0;
}
