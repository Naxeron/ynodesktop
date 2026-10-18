#include <iostream>
#include <stdlib.h>
#include <lcf/lmu/reader.h>
#include <lcf/rpg/map.h>

int main() {
    auto map = lcf::LMU_Reader::Load("Map0224.lmu", "");
    for (const auto& ev : map->events) {
        for (const auto& page : ev.pages) {
            for (const auto& cmd : page.event_commands) {
                if (cmd.code == 10830 || cmd.code == 10820) {
                    std::cout << "Event ID: " << ev.ID << " Code: " << cmd.code << "\n";
                }
            }
        }
    }
    exit(0);
}
