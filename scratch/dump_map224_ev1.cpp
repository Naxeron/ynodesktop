#include <iostream>
#include <stdlib.h>
#include <lcf/lmu/reader.h>
#include <lcf/rpg/map.h>

int main() {
    auto map = lcf::LMU_Reader::Load("scratch/Map0224.lmu", "");
    for (const auto& ev : map->events) {
        if (ev.ID == 1) {
            for (const auto& page : ev.pages) {
                std::cout << "  Page\n";
                for (const auto& cmd : page.event_commands) {
                    std::cout << "    Code: " << cmd.code << " Params: ";
                    for (int p : cmd.parameters) std::cout << p << " ";
                    std::cout << "\n";
                }
            }
        }
    }
    exit(0);
}
